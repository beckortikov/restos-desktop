const express = require('express')
const cors = require('cors')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDB, getDB, DB_PATH } = require('./db')

// ─── PostgREST-compatible API ───────────────────────────────────────────────

// Build a single WHERE expression for one (key, val) PostgREST filter pair.
// Returns { sql, params, nextIdx } where sql may be empty if unsupported.
function buildFilter(key, val, startIdx) {
  if (typeof val !== 'string') return { sql: '', params: [], nextIdx: startIdx }
  // Single-param helpers
  const param1 = (sql, value) => ({
    sql: sql.replace('$?', `$${startIdx}`),
    params: [value],
    nextIdx: startIdx + 1,
  })
  const noParam = (sql) => ({ sql, params: [], nextIdx: startIdx })

  if (val.startsWith('eq.')) {
    const v = val.slice(3)
    if (v === 'true')  return noParam(`"${key}" = true`)
    if (v === 'false') return noParam(`"${key}" = false`)
    if (v === 'null')  return noParam(`"${key}" IS NULL`)
    return param1(`"${key}" = $?`, v)
  }
  if (val.startsWith('neq.')) return param1(`"${key}" != $?`, val.slice(4))
  if (val.startsWith('gt.'))  return param1(`"${key}" > $?`,  val.slice(3))
  if (val.startsWith('gte.')) return param1(`"${key}" >= $?`, val.slice(4))
  if (val.startsWith('lt.'))  return param1(`"${key}" < $?`,  val.slice(3))
  if (val.startsWith('lte.')) return param1(`"${key}" <= $?`, val.slice(4))
  // PostgREST uses `*` as wildcard instead of `%`. Translate.
  // Explicit ::text cast prevents PG 'could not determine data type of parameter' errors.
  if (val.startsWith('like.'))  return param1(`"${key}" LIKE $?::text`,  val.slice(5).replace(/\*/g, '%'))
  // Use LOWER() instead of ILIKE because PGlite's default collation doesn't
  // fold Unicode (Cyrillic) characters case-insensitively in ILIKE.
  if (val.startsWith('ilike.')) return param1(`LOWER("${key}"::text) LIKE LOWER($?::text)`, val.slice(6).replace(/\*/g, '%'))
  if (val.startsWith('in.')) {
    let raw = val.slice(3)
    if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1)
    const values = raw.split(',').filter(v => v.length > 0)
    if (values.length === 0) return noParam('FALSE')
    let idx = startIdx
    const placeholders = values.map(() => `$${idx++}`).join(',')
    return { sql: `"${key}" IN (${placeholders})`, params: values, nextIdx: idx }
  }
  if (val.startsWith('is.')) {
    const v = val.slice(3)
    if (v === 'null')  return noParam(`"${key}" IS NULL`)
    if (v === 'true')  return noParam(`"${key}" = true`)
    if (v === 'false') return noParam(`"${key}" = false`)
    return noParam('')
  }
  if (val.startsWith('not.is.')) {
    const v = val.slice(7)
    if (v === 'null')  return noParam(`"${key}" IS NOT NULL`)
    if (v === 'true')  return noParam(`"${key}" != true`)
    if (v === 'false') return noParam(`"${key}" != false`)
    return noParam('')
  }
  if (val.startsWith('not.eq.'))   return param1(`"${key}" != $?`, val.slice(7))
  if (val.startsWith('not.like.')) return param1(`"${key}" NOT LIKE $?::text`,  val.slice(9).replace(/\*/g, '%'))
  if (val.startsWith('not.ilike.'))return param1(`LOWER("${key}"::text) NOT LIKE LOWER($?::text)`, val.slice(10).replace(/\*/g, '%'))
  return noParam('')
}

// Parse PostgREST `or=(filter1,filter2,...)` into a single SQL OR expression.
// filters look like `col.eq.value` or `col.is.null` or `col.ilike.*foo*`.
function parseOrFilter(orVal, startIdx) {
  let raw = orVal
  if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1)
  const parts = []
  // Split on commas that are not inside parentheses (to be safe with in.(a,b))
  let depth = 0, buf = ''
  for (const ch of raw) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { if (buf) parts.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf) parts.push(buf)

  const sqls = []
  const params = []
  let i = startIdx
  for (const p of parts) {
    // Each part is "col.op.value" possibly with 'not.' prefix
    const dotIdx = p.indexOf('.')
    if (dotIdx < 0) continue
    const col = p.slice(0, dotIdx)
    const opVal = p.slice(dotIdx + 1)
    const f = buildFilter(col, opVal, i)
    if (f.sql) {
      sqls.push(f.sql)
      params.push(...f.params)
      i = f.nextIdx
    }
  }
  return {
    sql: sqls.length > 0 ? '(' + sqls.join(' OR ') + ')' : '',
    params,
    nextIdx: i,
  }
}

function parseFilters(query) {
  const filters = []
  const params = []
  let paramIdx = 1
  for (const [key, val] of Object.entries(query)) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue
    if (typeof val !== 'string') continue

    // Handle PostgREST 'or=(...)' compound filter
    if (key === 'or') {
      const r = parseOrFilter(val, paramIdx)
      if (r.sql) { filters.push(r.sql); params.push(...r.params); paramIdx = r.nextIdx }
      continue
    }
    // Handle PostgREST 'and=(...)' compound filter
    if (key === 'and') {
      const r = parseOrFilter(val, paramIdx)
      // Same parsing, but join with AND. parseOrFilter currently joins with OR;
      // for AND we replicate the loop:
      const sqls = []
      let raw = val
      if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1)
      let i = paramIdx
      for (const p of raw.split(',')) {
        const dotIdx = p.indexOf('.')
        if (dotIdx < 0) continue
        const f = buildFilter(p.slice(0, dotIdx), p.slice(dotIdx + 1), i)
        if (f.sql) { sqls.push(f.sql); params.push(...f.params); i = f.nextIdx }
      }
      if (sqls.length) { filters.push('(' + sqls.join(' AND ') + ')'); paramIdx = i }
      continue
    }

    const f = buildFilter(key, val, paramIdx)
    if (f.sql) {
      filters.push(f.sql)
      params.push(...f.params)
      paramIdx = f.nextIdx
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
  'stock_writeoffs', 'stock_writeoff_lines', 'batch_cooking_logs',
  'supply_expenses', 'time_entries', 'assets', 'liabilities', 'equity_entries',
  'budget_lines', 'audit_log', 'menu_categories', 'custom_categories',
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

  // ─── PostgREST embed resolver ─────────────────────────────────────────────
  // Maps known FK relationships that the default `table.replace(/s$/,'')+'_id'`
  // rule can't infer (prefixed table names, group_id, etc.).
  const FK_MAP = {
    // parent → { child → fk_column_in_child }
    stock_writeoffs:     { stock_writeoff_lines: 'writeoff_id' },
    stock_receipts:      { stock_receipt_lines: 'receipt_id' },
    semi_finished_types: { semi_recipe_lines: 'semi_type_id', semi_finished_stock: 'semi_type_id' },
    cash_shifts:         { cash_shift_operations: 'shift_id' },
    modifier_groups:     { modifiers: 'group_id' },
    order_items:         { order_item_modifiers: 'order_item_id' },
  }

  function getChildFk(parent, child) {
    if (FK_MAP[parent]?.[child]) return FK_MAP[parent][child]
    return parent.replace(/s$/, '') + '_id'
  }

  // Lift numeric strings to numbers (PGlite returns NUMERIC as string).
  function liftNumerics(row) {
    const r = { ...row }
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)
          && !k.endsWith('_id') && k !== 'id' && k !== 'phone' && k !== 'password' && k !== 'restaurant_id') {
        r[k] = Number(v)
      }
    }
    return r
  }

  // Parse a PostgREST select string into an array of embed specs.
  // Examples it handles:
  //   `*`
  //   `*, child(*)`
  //   `*, child(*), parent(name)`
  //   `*, alias:parent!fk_constraint(name)`
  //   `id, name, total`     (column list — also returned)
  function parseSelect(selectStr) {
    if (!selectStr) selectStr = '*'
    const embeds = []
    const cols = []
    // Split top-level by commas (respecting parentheses)
    let depth = 0, buf = ''
    const parts = []
    for (const ch of selectStr) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue }
      buf += ch
    }
    if (buf.trim()) parts.push(buf.trim())

    for (const p of parts) {
      // alias:table!fk_constraint(cols)  OR  table!fk_constraint(cols)  OR  table(cols)
      const m = p.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/)
      if (m) {
        embeds.push({ alias: m[1] || m[2], table: m[2], fkConstraint: m[3], cols: m[4].trim() })
      } else if (p === '*') {
        cols.push('*')
      } else {
        cols.push(p)
      }
    }
    return { cols, embeds }
  }

  // Try to find the FK column in `parent` table that links to `child` (an aliased embed).
  // Uses the explicit constraint name when present (e.g., cash_shifts_opened_by_fkey → opened_by).
  async function findParentFkCol(db, parentTable, childTable, fkConstraint) {
    if (fkConstraint) {
      // Constraint name pattern: <parentTable>_<col>_fkey
      const m = fkConstraint.match(new RegExp(`^${parentTable}_(.+)_fkey$`))
      if (m) return m[1]
    }
    // Common candidates
    const candidates = [
      `${childTable.replace(/s$/, '')}_id`,    // user_id
      'created_by', 'user_id', 'opened_by', 'closed_by', 'cashier_id', 'waiter_id',
      'approved_by', 'paid_by', 'confirmed_by', 'discount_approved_by',
    ]
    try {
      const cc = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [parentTable])
      const existing = new Set(cc.rows.map(r => r.column_name))
      for (const c of candidates) if (existing.has(c)) return c
    } catch {}
    return null
  }

  async function resolveEmbeds(db, table, rows, embeds) {
    for (const embed of embeds) {
      // Determine if this is a child embed (array, FK in child) or parent embed (single, FK in parent)
      // Heuristic: if the child table has an FK that points to the parent table,
      // it's a child-of-parent (1:N). Otherwise it's a parent-of-this (N:1) lookup.
      const childTable = embed.table
      // Try child-of-parent first
      const childFk = getChildFk(table, childTable)
      let isChildEmbed = false
      try {
        const cc = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [childTable, childFk])
        if (cc.rows.length > 0) isChildEmbed = true
      } catch {}

      // Pick which columns to select (PostgREST cols are within the parens)
      const colList = (embed.cols && embed.cols !== '*')
        ? embed.cols.split(',').map(c => `"${c.trim()}"`).join(',')
        : '*'

      if (isChildEmbed) {
        // 1:N — array of children
        for (const row of rows) {
          try {
            const r = await db.query(`SELECT ${colList} FROM "${childTable}" WHERE "${childFk}" = $1`, [row.id])
            row[embed.alias] = r.rows.map(liftNumerics)
          } catch { row[embed.alias] = [] }
        }
      } else {
        // N:1 — find FK in parent table
        const parentFkCol = await findParentFkCol(db, table, childTable, embed.fkConstraint)
        for (const row of rows) {
          if (!parentFkCol || row[parentFkCol] == null) { row[embed.alias] = null; continue }
          try {
            const r = await db.query(`SELECT ${colList} FROM "${childTable}" WHERE id = $1 LIMIT 1`, [row[parentFkCol]])
            row[embed.alias] = r.rows.length > 0 ? liftNumerics(r.rows[0]) : null
          } catch { row[embed.alias] = null }
        }
      }
    }
    return rows
  }

  // GET
  async function handleGet(req, res, headOnly = false) {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const { where, params } = parseFilters(req.query)
      const order = parseOrder(req.query)

      // Range header support: "Range: 0-49" + "Range-Unit: items"
      let rangeFrom = null, rangeTo = null
      if (req.headers.range) {
        const m = req.headers.range.match(/^(\d+)-(\d+)$/)
        if (m) { rangeFrom = parseInt(m[1]); rangeTo = parseInt(m[2]) }
      }

      let limit = ''
      let offset = ''
      if (rangeFrom !== null && rangeTo !== null) {
        limit = ` LIMIT ${rangeTo - rangeFrom + 1}`
        offset = ` OFFSET ${rangeFrom}`
      } else {
        if (req.query.limit) limit = ` LIMIT ${parseInt(req.query.limit)}`
        if (req.query.offset) offset = ` OFFSET ${parseInt(req.query.offset)}`
      }

      // Parse select for partial columns + embeds
      const { cols: selectCols, embeds } = parseSelect(req.query.select)
      const wantCount = (req.headers.prefer || '').includes('count=exact')

      // Build the SELECT clause: include any non-embed columns + always the FK columns
      // we need for embeds (created_by, user_id, etc). Simplest: select * if there are
      // embeds, otherwise honor the column list.
      let selectClause = '*'
      if (embeds.length === 0 && selectCols.length > 0 && !selectCols.includes('*')) {
        selectClause = selectCols.map(c => `"${c.trim()}"`).join(',')
      }

      // For HEAD requests with count=exact, we only need the count.
      let totalCount = null
      if (wantCount || headOnly) {
        try {
          const cr = await db.query(`SELECT COUNT(*) AS c FROM "${table}"${where}`, params)
          totalCount = Number(cr.rows[0]?.c || 0)
        } catch {}
      }

      let rows = []
      if (!headOnly) {
        const sql = `SELECT ${selectClause} FROM "${table}"${where}${order}${limit}${offset}`
        const result = await db.query(sql, params)
        rows = result.rows.map(liftNumerics)
        if (embeds.length > 0) {
          await resolveEmbeds(db, table, rows, embeds)
        }
      }

      if (totalCount !== null) {
        const from = rangeFrom ?? 0
        const to = rows.length > 0 ? from + rows.length - 1 : 0
        res.setHeader('Content-Range', `${from}-${to}/${totalCount}`)
      }

      // .single() — Accept: application/vnd.pgrst.object+json
      if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
        res.setHeader('Content-Type', 'application/vnd.pgrst.object+json; charset=utf-8')
        if (rows.length === 0) return res.status(406).json({ message: 'Not found' })
        return res.send(JSON.stringify(rows[0]))
      }

      if (headOnly) {
        return res.status(rangeFrom !== null ? 206 : 200).end()
      }
      res.status(rangeFrom !== null ? 206 : 200).json(rows)
    } catch (err) {
      console.error(`[GET] ${table} error:`, err.message)
      res.status(500).json({ error: err.message })
    }
  }

  // Express routes HEAD requests through the GET handler automatically.
  // We detect the method inside the handler instead of registering a separate route.
  app.get('/rest/v1/:table', (req, res) => handleGet(req, res, req.method === 'HEAD'))

  // Helper: ensure all columns from `row` exist on `table`. Auto-creates missing columns as TEXT.
  async function ensureColumns(db, table, row) {
    try {
      const colCheck = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table]
      )
      const existing = new Set(colCheck.rows.map(r => r.column_name))
      for (const col of Object.keys(row)) {
        if (!existing.has(col)) {
          try {
            await db.query(`ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT`)
            console.log(`[schema] +${table}.${col}`)
          } catch (e) { /* ignore */ }
        }
      }
    } catch {}
  }

  // POST
  app.post('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const data = Array.isArray(req.body) ? req.body : [req.body]
      // Auto-create missing columns based on first row keys
      if (data.length > 0) await ensureColumns(db, table, data[0])
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
      // Auto-create missing columns
      await ensureColumns(db, table, data)
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
  // Checks CLOUD first (real-time), falls back to local DB if offline.
  app.get('/license-check', async (req, res) => {
    try {
      const cfg = loadConfig()
      if (!cfg.restaurantId) return res.json({ blocked: false })

      let row = null

      // Try cloud first for real-time block/license status
      if (cfg.supabaseUrl && cfg.supabaseKey) {
        try {
          const cloudRes = await fetch(
            `${cfg.supabaseUrl}/rest/v1/restaurants?id=eq.${cfg.restaurantId}&select=is_blocked,block_reason,license_expires_at`,
            {
              headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}` },
              signal: AbortSignal.timeout(5000),
            }
          )
          if (cloudRes.ok) {
            const rows = await cloudRes.json()
            if (Array.isArray(rows) && rows.length > 0) row = rows[0]
          }
        } catch {} // Offline — fall through to local
      }

      // Fallback to local DB
      if (!row) {
        const db = getDB()
        const result = await db.query(
          'SELECT is_blocked, block_reason, license_expires_at FROM restaurants WHERE id = $1',
          [cfg.restaurantId]
        )
        row = result.rows[0]
      }

      if (!row) return res.json({ blocked: false })

      // Check explicit block
      const explicitlyBlocked = row.is_blocked === true || row.is_blocked === 'true'

      // Check license expiry
      const licenseExpired = row.license_expires_at && new Date(row.license_expires_at) < new Date()

      const blocked = explicitlyBlocked || licenseExpired
      const reason = licenseExpired
        ? `Лицензия истекла ${new Date(row.license_expires_at).toLocaleDateString('ru')}. Обратитесь к администратору.`
        : (row.block_reason || 'Заблокировано администратором')

      if (blocked) {
        isBlocked = true
        blockReason = reason
      } else {
        isBlocked = false
        blockReason = ''
      }

      res.json({ blocked, reason: blocked ? reason : '' })
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

  // Kill any zombie process holding the port (previous RestOS that didn't exit cleanly)
  async function killPortHolder(p) {
    try {
      const { execSync } = require('child_process')
      if (process.platform === 'win32') {
        // Windows: find PID on port and kill it
        const out = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, { encoding: 'utf8', timeout: 3000 }).trim()
        const lines = out.split('\n').filter(Boolean)
        const pids = new Set(lines.map(l => l.trim().split(/\s+/).pop()).filter(Boolean))
        for (const pid of pids) {
          if (pid !== String(process.pid)) {
            try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 }) } catch {}
            console.log(`[API] Killed zombie process PID ${pid} on port ${p}`)
          }
        }
      } else {
        // macOS / Linux: lsof + kill
        const out = execSync(`lsof -ti :${p}`, { encoding: 'utf8', timeout: 3000 }).trim()
        const pids = out.split('\n').filter(Boolean)
        for (const pid of pids) {
          if (pid !== String(process.pid)) {
            try { process.kill(Number(pid), 'SIGKILL') } catch {}
            console.log(`[API] Killed zombie process PID ${pid} on port ${p}`)
          }
        }
      }
      // Brief pause so the OS releases the port
      await new Promise(r => setTimeout(r, 500))
    } catch {
      // No process on port — good
    }
  }

  // Listen — with auto-retry after killing zombie process
  return new Promise((resolve, reject) => {
    const ip = getLocalIP()
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[API] http://localhost:${port}`)
      console.log(`[API] http://${ip}:${port}`)
      console.log(`[API] Waiters connect: http://${ip}:${port}`)
      resolve({
        port, ip, server,
        onBlocked: (cb) => { onBlockedCallback = cb },
        onUnblocked: (cb) => { onUnblockedCallback = cb },
      })
    })
    server.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[API] Port ${port} in use — killing zombie process...`)
        await killPortHolder(port)
        // Retry once
        const retry = app.listen(port, '0.0.0.0', () => {
          console.log(`[API] http://localhost:${port} (after port recovery)`)
          resolve({
            port, ip, server: retry,
            onBlocked: (cb) => { onBlockedCallback = cb },
            onUnblocked: (cb) => { onUnblockedCallback = cb },
          })
        })
        retry.on('error', (e) => {
          console.error(`[API] Port ${port} still in use after kill:`, e.message)
          const { dialog } = require('electron')
          dialog.showErrorBox('RestOS', `Порт ${port} занят другим приложением.\nЗакройте его и перезапустите RestOS.`)
          reject(e)
        })
      } else {
        reject(err)
      }
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
