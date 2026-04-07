const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron')
const path = require('path')
const { startAPIServer, setDesktopHandlers, setUpdateState } = require('./api-server')

let mainWindow = null
let tray = null
const API_PORT = 3001

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) { app.quit(); return }

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'RestOS',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
    autoHideMenuBar: true,
    show: false,
  })

  // Load frontend via Express server (handles absolute paths correctly)
  mainWindow.loadURL(`http://localhost:${API_PORT}`)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.maximize()
  })

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Открыть RestOS', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { type: 'separator' },
    { label: `API: http://localhost:${API_PORT}`, enabled: false },
    { label: 'Подключить официантов (QR)', click: () => shell.openExternal(`http://localhost:${API_PORT}/connect`) },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit() } },
  ])

  tray.setToolTip('RestOS — Система управления рестораном')
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

// Auto-updater with IPC events
let autoUpdaterRef = null
function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdaterRef = autoUpdater
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      setUpdateState({ status: 'checking', version: null, percent: 0, error: null })
    })
    autoUpdater.on('update-not-available', () => {
      setUpdateState({ status: 'not-available' })
    })
    autoUpdater.on('update-available', (info) => {
      console.log('[updater] Update available:', info.version)
      setUpdateState({ status: 'available', version: info.version })
      mainWindow?.webContents.send('update-status', { status: 'downloading', version: info.version })
    })
    autoUpdater.on('download-progress', (progress) => {
      setUpdateState({ status: 'downloading', percent: Math.round(progress.percent) })
      mainWindow?.webContents.send('update-status', { status: 'progress', percent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[updater] Update downloaded:', info.version)
      setUpdateState({ status: 'ready', version: info.version, percent: 100 })
      mainWindow?.webContents.send('update-status', { status: 'ready', version: info.version })

      // Check if this is a critical update (release notes contain [CRITICAL])
      const isCritical = (info.releaseNotes || '').toString().includes('[CRITICAL]')

      if (isCritical) {
        // Force update — block the app until restart
        console.log('[updater] CRITICAL update — forcing restart')
        mainWindow?.webContents.executeJavaScript(`
          document.body.innerHTML = '<div style="position:fixed;inset:0;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;font-family:system-ui;z-index:999999"><div style="text-align:center"><h1 style="font-size:24px;margin-bottom:12px">Критическое обновление v${info.version}</h1><p style="color:#a1a1aa;margin-bottom:24px">Требуется перезагрузка для продолжения работы</p><button onclick="window.restosDesktop.installUpdate()" style="background:#3b82f6;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer">Перезагрузить сейчас</button></div></div>';
        `).catch(() => {})
        // Auto-restart after 30 seconds if user doesn't click
        setTimeout(() => autoUpdater.quitAndInstall(), 30000)
      } else {
        // Normal update — show banner
        mainWindow?.webContents.executeJavaScript(`
          if (!document.getElementById('restos-update-bar')) {
            const bar = document.createElement('div');
            bar.id = 'restos-update-bar';
            bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1d4ed8;color:#fff;padding:8px 16px;font-family:system-ui;font-size:13px;display:flex;align-items:center;justify-content:center;gap:12px;';
            bar.innerHTML = 'Обновление v${info.version} готово <button onclick="window.restosDesktop.installUpdate()" style="background:#fff;color:#1d4ed8;border:none;padding:4px 12px;border-radius:4px;font-weight:600;cursor:pointer;font-size:13px;">Перезагрузить</button>';
            document.body.prepend(bar);
          }
        `).catch(() => {})
      }
    })
    autoUpdater.on('error', (err) => {
      console.log('[updater] Error:', err.message)
      setUpdateState({ status: 'error', error: err.message })
    })

    // IPC: install update now
    ipcMain.on('install-update', () => {
      autoUpdater.quitAndInstall()
    })

    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  } catch (e) {
    console.log('[updater] Not available:', e.message)
  }
}

// App lifecycle
app.whenReady().then(async () => {
  // Start API server (PGlite + Express)
  const server = await startAPIServer(API_PORT)
  console.log(`[RestOS] API server running on port ${API_PORT}`)

  // Handle license blocked/unblocked from sync engine
  server.onBlocked((reason) => {
    console.log('[RestOS] License blocked:', reason)
    mainWindow?.webContents.send('license-blocked', { reason })
    // Reload to show blocked page
    mainWindow?.loadURL(`http://localhost:${API_PORT}`)
  })
  server.onUnblocked(() => {
    console.log('[RestOS] License unblocked')
    // Reload to show main app
    mainWindow?.loadURL(`http://localhost:${API_PORT}`)
  })

  createWindow()
  createTray()
  setupAutoUpdater()

  // Register desktop control handlers (called by api-server /desktop/* routes)
  setDesktopHandlers({
    checkUpdate: async () => {
      if (!autoUpdaterRef) throw new Error('Updater unavailable')
      return await autoUpdaterRef.checkForUpdates()
    },
    installUpdate: () => {
      if (!autoUpdaterRef) throw new Error('Updater unavailable')
      autoUpdaterRef.quitAndInstall()
    },
    openConnect: () => {
      shell.openExternal(`http://localhost:${API_PORT}/connect`)
    },
  })
})

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
})

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
  else mainWindow.show()
})
