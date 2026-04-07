const express = require('express')
const cors = require('cors')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDB, getDB, DB_PATH } = require('./db')

// ─── PostgREST-compatible API ───────────────────────────────────────────────

function parseFilters(query) {
  const filters = []
  const params = []
  let paramIdx = 1
  for (const [key, val] of Object.entries(query)) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue
    if (typeof val !== 'string') continue
    if (val.startsWith('eq.')) {
      const v = val.slice(3)
      // Handle booleans: eq.true / eq.false → use SQL boolean, not string
      if (v === 'true') { filters.push(`"${key}" = true`); }
      else if (v === 'false') { filters.push(`"${key}" = false`); }
      else { filters.push(`"${key}" = $${paramIdx++}`); params.push(v) }
    }
    else if (val.startsWith('neq.')) { filters.push(`"${key}" != $${paramIdx++}`); params.push(val.slice(4)) }
    else if (val.startsWith('gt.')) { filters.push(`"${key}" > $${paramIdx++}`); params.push(val.slice(3)) }
    else if (val.startsWith('gte.')) { filters.push(`"${key}" >= $${paramIdx++}`); params.push(val.slice(4)) }
    else if (val.startsWith('lt.')) { filters.push(`"${key}" < $${paramIdx++}`); params.push(val.slice(3)) }
    else if (val.startsWith('lte.')) { filters.push(`"${key}" <= $${paramIdx++}`); params.push(val.slice(4)) }
    else if (val.startsWith('like.')) { filters.push(`"${key}" LIKE $${paramIdx++}`); params.push(val.slice(5)) }
    else if (val.startsWith('ilike.')) { filters.push(`"${key}" ILIKE $${paramIdx++}`); params.push(val.slice(6)) }
    else if (val.startsWith('in.')) {
      const values = val.slice(4, -1).split(',')
      filters.push(`"${key}" IN (${values.map(() => `$${paramIdx++}`).join(',')})`)
      params.push(...values)
    }
    else if (val.startsWith('is.')) {
      const v = val.slice(3)
      if (v === 'null') filters.push(`"${key}" IS NULL`)
      else if (v === 'true') filters.push(`"${key}" = true`)
      else if (v === 'false') filters.push(`"${key}" = false`)
    }
    else if (val.startsWith('not.is.')) {
      if (val.slice(7) === 'null') filters.push(`"${key}" IS NOT NULL`)
    }
  }
  return { where: filters.length > 0 ? ' WHERE ' + filters.join(' AND ') : '', params }
}

function parseOrder(query) {
  if (!query.order) return ''
  return ' ORDER BY ' + query.order.split(',').map(p => {
    const [col, dir] = p.trim().split('.')
    return `"${col}" ${dir === 'desc' ? 'DESC' : 'ASC'}`
  }).join(', ')
}

const TABLES = [
  'restaurants', 'users', 'zones', 'tables', 'menu_items', 'tech_card_lines',
  'ingredients', 'orders', 'order_items', 'order_item_modifiers',
  'financial_accounts', 'financial_operations', 'stock_movements',
  'suppliers', 'stock_receipts', 'stock_receipt_lines',
  'cash_shifts', 'cash_shift_operations', 'reservations', 'customers',
  'order_voids', 'order_splits', 'modifier_groups', 'modifiers',
  'semi_finished_types', 'semi_recipe_lines', 'semi_finished_stock',
  'stock_writeoffs', 'writeoff_lines', 'batch_cooking_logs',
  'supply_expenses', 'time_entries', 'assets', 'liabilities', 'equity',
  'budget_lines', 'audit_log',
]

// Desktop control state — populated by main.js via setDesktopHandlers
let desktopHandlers = {
  checkUpdate: null,
  installUpdate: null,
  openConnect: null,
}
let updateState = { status: 'idle', version: null, percent: 0, error: null }

async function startAPIServer(port = 3001) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  await initDB()

  // ─── SSE: real-time notifications to all connected clients ────────────
  const sseClients = new Set()

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write('data: {"type":"connected"}\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
  })

  function notifyClients(tableName, action) {
    const msg = `data: ${JSON.stringify({ type: 'change', table: tableName, action, ts: Date.now() })}\n\n`
    for (const client of sseClients) {
      try { client.write(msg) } catch { sseClients.delete(client) }
    }
  }

  // Serve frontend static assets (JS, CSS, images) but NOT index.html
  // index.html is handled by the SPA fallback which checks activation status
  const frontendDir = path.join(__dirname, 'frontend')
  if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir, { index: false }))
  }

  // GET
  app.get('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const { where, params } = parseFilters(req.query)
      const order = parseOrder(req.query)
      const limit = req.query.limit ? ` LIMIT ${parseInt(req.query.limit)}` : ''
      const offset = req.query.offset ? ` OFFSET ${parseInt(req.query.offset)}` : ''

      const sql = `SELECT * FROM "${table}"${where}${order}${limit}${offset}`
      const result = await db.query(sql, params)
      let rows = result.rows.map(row => {
        const r = { ...row }
        for (const [key, val] of Object.entries(r)) {
          if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val) && !key.endsWith('_id') && key !== 'id' && key !== 'phone' && key !== 'password' && key !== 'restaurant_id') {
            r[key] = Number(val)
          }
        }
        return r
      })

      // Nested selects
      const selectParam = req.query.select || '*'
      const nestedMatch = selectParam.match(/(\w+)\(\*\)/g)
      if (nestedMatch) {
        for (const match of nestedMatch) {
          const child = match.replace('(*)', '')
          if (!TABLES.includes(child)) continue
          const fk = table.replace(/s$/, '') + '_id'
          for (const row of rows) {
            try {
              const childResult = await db.query(`SELECT * FROM "${child}" WHERE "${fk}" = $1`, [row.id])
              row[child] = childResult.rows.map(cr => {
                const c = { ...cr }
                for (const [k, v] of Object.entries(c)) {
                  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !k.endsWith('_id') && k !== 'id' && k !== 'phone' && k !== 'password' && k !== 'restaurant_id') c[k] = Number(v)
                }
                return c
              })
            } catch { row[child] = [] }
          }
        }
      }

      // .single()
      if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
        res.setHeader('Content-Type', 'application/vnd.pgrst.object+json; charset=utf-8')
        if (rows.length === 0) return res.status(406).json({ message: 'Not found' })
        return res.send(JSON.stringify(rows[0]))
      }

      res.json(rows)
    } catch (err) {
      console.error(`[GET] ${table} error:`, err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // POST
  app.post('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const data = Array.isArray(req.body) ? req.body : [req.body]
      // Check if table has updated_at column
      let hasUpdatedAt = false
      try {
        const colCheck = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'updated_at'`, [table])
        hasUpdatedAt = colCheck.rows.length > 0
      } catch {}
      const now = new Date().toISOString()
      const results = []
      for (const row of data) {
        if (!row.id) row.id = require('crypto').randomUUID()
        if (hasUpdatedAt && row.updated_at === undefined) row.updated_at = now
        const cols = Object.keys(row)
        const vals = cols.map((_, i) => `$${i + 1}`)
        const sql = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${vals.join(',')}) RETURNING *`
        const result = await db.query(sql, cols.map(c => row[c] ?? null))
        results.push(result.rows[0])
      }
      notifyClients(table, 'insert')
      res.status(201).json(Array.isArray(req.body) ? results : results[0])
    } catch (err) {
      console.error(`[POST] ${table} error:`, err.message)
      res.status(400).json({ error: err.message })
    }
  })

  // PATCH
  app.patch('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const { where, params } = parseFilters(req.query)
      const data = { ...req.body }
      // Auto-set updated_at if table has it (for sync conflict resolution)
      try {
        const colCheck = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'updated_at'`, [table])
        if (colCheck.rows.length > 0 && data.updated_at === undefined) {
          data.updated_at = new Date().toISOString()
        }
      } catch {}
      const cols = Object.keys(data)
      const setClause = cols.map((c, i) => `"${c}" = $${params.length + i + 1}`).join(', ')
      const sql = `UPDATE "${table}" SET ${setClause}${where} RETURNING *`
      const result = await db.query(sql, [...params, ...cols.map(c => data[c] ?? null)])
      notifyClients(table, 'update')
      if ((req.headers.prefer || '').includes('return=representation')) {
        res.json(result.rows.length === 1 ? result.rows[0] : result.rows)
      } else {
        res.json({ count: result.rows.length })
      }
    } catch (err) {
      console.error(`[PATCH] ${table} error:`, err.message)
      res.status(400).json({ error: err.message })
    }
  })

  // DELETE
  app.delete('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const { where, params } = parseFilters(req.query)
      await db.query(`DELETE FROM "${table}"${where}`, params)
      notifyClients(table, 'delete')
      res.json({ count: 1 })
    } catch (err) {
      console.error(`[DELETE] ${table} error:`, err.message)
      res.status(400).json({ error: err.message })
    }
  })

  // Fake auth
  app.get('/auth/v1/user', (req, res) => res.json(null))
  app.post('/auth/v1/token', (req, res) => res.json({ access_token: 'local', token_type: 'bearer' }))
  app.get('/auth/v1/settings', (req, res) => res.json({ external: {}, disable_signup: true }))

  // Waiter connect page with QR code
  app.get('/connect', (req, res) => {
    const ip = getLocalIP()
    const url = `http://${ip}:${port}`
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RestOS — Подключение официантов</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}
.card{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:40px;max-width:400px}
h1{font-size:20px;margin-bottom:8px}p{color:#a1a1aa;font-size:14px;margin-bottom:24px}
.url{font-family:monospace;font-size:18px;background:#27272a;padding:12px 20px;border-radius:8px;margin-bottom:24px;letter-spacing:1px;color:#3b82f6}
.qr{margin:0 auto 16px}
.hint{color:#52525b;font-size:12px}</style></head>
<body><div class="card">
<h1>Подключение официантов</h1>
<p>Отсканируйте QR-код или введите адрес в браузере телефона</p>
<div class="qr"><img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}" width="200" height="200" alt="QR"></div>
<div class="url">${url}</div>
<p class="hint">Телефон должен быть в той же WiFi сети</p>
</div></body></html>`)
  })

  // Status
  app.get('/status', async (req, res) => {
    const db = getDB()
    const r = await db.query('SELECT COUNT(*) as c FROM orders')
    res.json({ status: 'running', uptime: Math.round(process.uptime()), ordersCount: Number(r.rows[0]?.c || 0) })
  })

  // Config
  const configPath = path.join(path.dirname(DB_PATH), 'config.json')
  function loadConfig() {
    try { if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
    return {}
  }
  function saveConfig(c) {
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2))
  }

  // Blocked state tracking
  let isBlocked = false
  let blockReason = ''

  // License check endpoint (used by blocked.html retry button)
  app.get('/license-check', async (req, res) => {
    try {
      const db = getDB()
      const cfg = loadConfig()
      if (!cfg.restaurantId) return res.json({ blocked: false })
      const result = await db.query('SELECT is_blocked, block_reason FROM restaurants WHERE id = $1', [cfg.restaurantId])
      const row = result.rows[0]
      const blocked = row && (row.is_blocked === true || row.is_blocked === 'true')
      if (!blocked) {
        isBlocked = false
        blockReason = ''
      }
      res.json({ blocked, reason: row?.block_reason || '' })
    } catch (err) {
      res.json({ blocked: false })
    }
  })

  // Print endpoints (built-in print server for Electron)
  const net = require('net')
  app.post('/print', (req, res) => {
    const { printerIP, data } = req.body
    if (!printerIP || !data) return res.status(400).json({ error: 'printerIP and data required' })
    const port = 9100
    const client = new net.Socket()
    client.setTimeout(5000)
    client.connect(port, printerIP, () => {
      client.write(Buffer.from(data, 'hex'), () => {
        client.destroy()
        res.json({ success: true })
      })
    })
    client.on('error', (err) => {
      client.destroy()
      res.status(500).json({ error: `Printer connection failed: ${err.message}` })
    })
    client.on('timeout', () => {
      client.destroy()
      res.status(500).json({ error: 'Printer connection timeout' })
    })
  })

  app.get('/print/status', (req, res) => {
    res.json({ status: 'ok' })
  })

  // Activate
  app.post('/activate', async (req, res) => {
    const { licenseKey } = req.body
    if (!licenseKey) return res.status(400).json({ error: 'Key required' })
    try {
      const URL = 'https://xmittbfenlknwtxeohbz.supabase.co'
      const KEY = 'sb_publishable_siDu3MFzNOOYvMAcjrSLnQ_xR2gtrf5'
      const r = await fetch(`${URL}/rest/v1/restaurants?license_key=eq.${encodeURIComponent(licenseKey)}&limit=1`,
        { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
      const data = await r.json()
      if (!Array.isArray(data) || !data.length) return res.status(404).json({ error: 'Invalid key' })
      // Clear all existing data before activating new restaurant
      const db = getDB()
      for (const t of TABLES) {
        try { await db.query(`DELETE FROM "${t}"`) } catch {}
      }
      console.log('[activate] Cleared all tables for fresh activation')
      saveConfig({ supabaseUrl: URL, supabaseKey: KEY, restaurantId: data[0].id, restaurantName: data[0].name, licenseKey })
      const { SyncEngine } = require('./sync')
      const sync = new SyncEngine(URL, KEY, data[0].id, {
        onBlocked: (reason) => { isBlocked = true; blockReason = reason; onBlockedCallback?.(reason) },
        onUnblocked: () => { isBlocked = false; blockReason = ''; onUnblockedCallback?.() },
      })
      await sync.pullFromCloud(true) // initial pull — all tables including operational
      sync.start()
      res.json({ success: true, restaurantName: data[0].name })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  // ─── Desktop control endpoints ─────────────────────────────────────────────
  // Only allow from localhost
  function isLocalhost(req) {
    const host = req.headers.host || ''
    return host.startsWith('localhost') || host.startsWith('127.0.0.1')
  }

  app.get('/desktop/update-status', (req, res) => {
    res.json(updateState)
  })

  app.post('/desktop/check-update', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    if (!desktopHandlers.checkUpdate) return res.status(503).json({ error: 'unavailable' })
    try {
      updateState = { status: 'checking', version: null, percent: 0, error: null }
      const result = await desktopHandlers.checkUpdate()
      res.json({ ok: true, result })
    } catch (e) {
      updateState = { ...updateState, status: 'error', error: e.message }
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/desktop/install-update', (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    if (!desktopHandlers.installUpdate) return res.status(503).json({ error: 'unavailable' })
    try {
      desktopHandlers.installUpdate()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/desktop/open-connect', (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    if (!desktopHandlers.openConnect) return res.status(503).json({ error: 'unavailable' })
    try {
      desktopHandlers.openConnect()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Activation & blocked pages
  const activatePage = path.join(__dirname, 'activate.html')
  const blockedPage = path.join(__dirname, 'blocked.html')

  // Inject restosDesktop config into index.html (preload.js doesn't work with loadURL)
  const pkgVersion = require('./package.json').version
  function serveIndexWithConfig(req, res) {
    const indexPath = path.join(frontendDir, 'index.html')
    if (!fs.existsSync(indexPath)) return res.status(500).send('Frontend not found')
    let html = fs.readFileSync(indexPath, 'utf8')

    const requestHost = req.headers.host || `localhost:${port}`
    const apiUrl = `http://${requestHost}`
    const ip = getLocalIP()

    // Detect if request comes from Electron (localhost) or phone (external IP)
    const isFromElectron = requestHost.startsWith('localhost') || requestHost.startsWith('127.0.0.1')

    let script
    if (isFromElectron) {
      // Full desktop config with connect button
      script = `<script>window.restosDesktop={isDesktop:true,apiUrl:"${apiUrl}",printServerUrl:"${apiUrl}",waiterUrl:"http://${ip}:${port}",connectUrl:"${apiUrl}/connect",version:"${pkgVersion}"};</script>`
    } else {
      // Waiter/phone — only apiUrl for data access, no desktop features
      script = `<script>window.restosDesktop={isDesktop:false,isLocal:true,apiUrl:"${apiUrl}",printServerUrl:"${apiUrl}",version:"${pkgVersion}"};</script>`
    }

    html = html.replace('<head>', '<head>' + script)
    // Remove external Google Fonts (blocks page load offline)
    html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, '')
    html = html.replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '')
    res.type('html').send(html)
  }

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/rest/') || req.path.startsWith('/auth/') || req.path === '/status') return res.status(404).end()
    // If not activated, show activation page
    const cfg = loadConfig()
    if (!cfg.restaurantId) {
      return res.sendFile(activatePage)
    }
    // If blocked, show blocked page
    if (isBlocked) {
      return res.sendFile(blockedPage)
    }
    serveIndexWithConfig(req, res)
  })

  // Callbacks for main process (set externally)
  let onBlockedCallback = null
  let onUnblockedCallback = null

  // Start sync if configured
  const cfg = loadConfig()
  if (cfg.supabaseUrl && cfg.restaurantId) {
    const { SyncEngine } = require('./sync')
    const sync = new SyncEngine(cfg.supabaseUrl, cfg.supabaseKey, cfg.restaurantId, {
      onBlocked: (reason) => { isBlocked = true; blockReason = reason; onBlockedCallback?.(reason) },
      onUnblocked: () => { isBlocked = false; blockReason = ''; onUnblockedCallback?.() },
    })
    sync.start(60000)
  }

  // Listen
  return new Promise((resolve) => {
    const ip = getLocalIP()
    app.listen(port, '0.0.0.0', () => {
      console.log(`[API] http://localhost:${port}`)
      console.log(`[API] http://${ip}:${port}`)
      console.log(`[API] Waiters connect: http://${ip}:${port}`)
      resolve({ port, ip, onBlocked: (cb) => { onBlockedCallback = cb }, onUnblocked: (cb) => { onUnblockedCallback = cb } })
    })
  })
}

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const c of iface || []) { if (c.family === 'IPv4' && !c.internal) return c.address }
  }
  return '127.0.0.1'
}

function setDesktopHandlers(handlers) {
  desktopHandlers = { ...desktopHandlers, ...handlers }
}

function setUpdateState(state) {
  updateState = { ...updateState, ...state }
}

module.exports = { startAPIServer, setDesktopHandlers, setUpdateState }
