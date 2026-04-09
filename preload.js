const { contextBridge, ipcRenderer } = require('electron')

// Read version safely — sandboxed preload may not have access to require('./package.json')
let pkgVersion = 'unknown'
try { pkgVersion = require('./package.json').version } catch {}

// Expose safe APIs to renderer.
// IMPORTANT: contextBridge creates a FROZEN, non-configurable property on `window`.
// The HTML inject in api-server.js also sets `window.restosDesktop = {...}` but
// that assignment silently fails because contextBridge's property wins. So ALL
// fields that the frontend checks (connectUrl, waiterUrl, etc.) must be defined HERE.
// The actual local IP for waiterUrl is set at runtime by the HTML inject only if
// the preload doesn't run (shouldn't happen), so we use localhost as default.
contextBridge.exposeInMainWorld('restosDesktop', {
  isDesktop: true,
  apiUrl: 'http://localhost:3001',
  printServerUrl: 'http://localhost:3001',
  connectUrl: 'http://localhost:3001/connect',
  waiterUrl: 'http://localhost:3001',
  version: pkgVersion,

  // Auto-updater
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  installUpdate: () => ipcRenderer.send('install-update'),

  // License blocked
  onBlocked: (callback) => ipcRenderer.on('license-blocked', (_, data) => callback(data)),
})
