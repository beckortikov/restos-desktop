const { contextBridge, ipcRenderer } = require('electron')

// Read version safely — sandboxed preload may not have access to require('./package.json')
let pkgVersion = 'unknown'
try { pkgVersion = require('./package.json').version } catch {}

// Expose safe APIs to renderer
contextBridge.exposeInMainWorld('restosDesktop', {
  isDesktop: true,
  apiUrl: 'http://localhost:3001',
  printServerUrl: 'http://localhost:3001',
  version: pkgVersion,

  // Auto-updater
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  installUpdate: () => ipcRenderer.send('install-update'),

  // License blocked
  onBlocked: (callback) => ipcRenderer.on('license-blocked', (_, data) => callback(data)),
})
