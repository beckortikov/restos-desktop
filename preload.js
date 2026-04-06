const { contextBridge, ipcRenderer } = require('electron')

// Expose safe APIs to renderer
contextBridge.exposeInMainWorld('restosDesktop', {
  isDesktop: true,
  apiUrl: 'http://localhost:3001',
  printServerUrl: 'http://localhost:3001',
  version: require('./package.json').version,

  // Auto-updater
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  installUpdate: () => ipcRenderer.send('install-update'),

  // License blocked
  onBlocked: (callback) => ipcRenderer.on('license-blocked', (_, data) => callback(data)),
})
