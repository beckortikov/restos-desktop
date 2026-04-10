const { getDB } = require('./db')
const os = require('os')

// Tables to PULL from cloud — both reference data AND operational data.
// Operational tables (orders, tables, shifts) need bidirectional sync so multiple
// desktops/devices stay consistent. Conflict resolution via EXCLUDED.updated_at >
// local.updated_at (see pullFromCloud) prevents overwriting local newer changes.
const PULL_TABLES = [
  // Reference/config data
  'restaurants', 'users', 'zones', 'menu_items', 'tech_card_lines',
  'ingredients', 'financial_accounts', 'modifier_groups', 'modifiers',
  'semi_finished_types', 'semi_recipe_lines', 'semi_finished_stock',
  'suppliers', 'customers',
  'assets', 'liabilities', 'equity_entries', 'budget_lines',
  // Operational data (multi-device sync)
  'tables', 'orders', 'order_items', 'order_item_modifiers',
  'cash_shifts', 'cash_shift_operations', 'reservations',
  'financial_operations', 'stock_movements',
  'order_voids', 'order_splits',
  'stock_writeoffs', 'stock_writeoff_lines',
  'stock_receipts', 'stock_receipt_lines',
  'batch_cooking_logs', 'supply_expenses', 'time_entries',
]

// On first activation we also pull historical/append-only tables
const INITIAL_PULL_TABLES = [
  ...PULL_TABLES,
  'audit_log',
]

// Tables to PUSH to cloud (data created/modified locally)
// ORDER IS CRITICAL — parents must come before children to satisfy FK constraints
// when pushing brand-new rows to cloud.
const PUSH_TABLES = [
  // Reference / config (no FK dependencies on other writable tables)
  'zones', 'customers', 'suppliers', 'ingredients',
  'financial_accounts', 'modifier_groups', 'modifiers',
  'semi_finished_types', 'semi_recipe_lines', 'semi_finished_stock',
  'assets', 'liabilities', 'equity_entries', 'budget_lines',
  // Menu (depends on ingredients via tech_card_lines)
  'menu_items', 'tech_card_lines',
  // Tables (depends on zones)
  'tables',
  // Cash shifts (depends on users which are pulled-only)
  'cash_shifts', 'cash_shift_operations',
  // Orders + dependencies (depends on tables, menu_items, modifiers, users)
  'orders', 'order_items', 'order_item_modifiers',
  'order_voids', 'order_splits',
  'reservations',
  // Stock movements
  'stock_receipts', 'stock_receipt_lines',
  'stock_writeoffs', 'stock_writeoff_lines',
  'stock_movements',
  // Finance (depends on financial_accounts)
  'financial_operations',
  // Batch cooking + supply (depends on menu_items / ingredients)
  'batch_cooking_logs', 'supply_expenses',
  // Time tracking (depends on users)
  'time_entries',
  // Audit log
  'audit_log',
]

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const c of iface || []) { if (c.family === 'IPv4' && !c.internal) return c.address }
  }
  return '127.0.0.1'
}

class SyncEngine {
  constructor(supabaseUrl, supabaseKey, restaurantId, options = {}) {
    this.supabaseUrl = supabaseUrl
    this.supabaseKey = supabaseKey
    this.restaurantId = restaurantId
    this.syncing = false
    this.onBlocked = options.onBlocked || null
    this.onUnblocked = options.onUnblocked || null
    this.wasBlocked = false
  }

  async sendHeartbeat() {
    try {
      const version = require('./package.json').version
      const ip = getLocalIP()
      await fetch(
        `${this.supabaseUrl}/rest/v1/restaurants?id=eq.${this.restaurantId}`,
        {
          method: 'PATCH',
          headers: {
            apikey: this.supabaseKey,
            Authorization: `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            last_seen_at: new Date().toISOString(),
            app_version: version,
            local_server_ip: ip,
          }),
        }
      )
    } catch (err) {
      console.log('[heartbeat] Failed:', err.message)
    }
  }

  async checkBlocked() {
    let row = null

    // Check CLOUD first for real-time status (block can happen any second)
    try {
      const res = await fetch(
        `${this.supabaseUrl}/rest/v1/restaurants?id=eq.${this.restaurantId}&select=is_blocked,block_reason,license_expires_at`,
        {
          headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        }
      )
      if (res.ok) {
        const rows = await res.json()
        if (Array.isArray(rows) && rows.length > 0) row = rows[0]
      }
    } catch {} // Offline — fall through to local

    // Fallback to local DB
    if (!row) {
      try {
        const db = getDB()
        const result = await db.query(
          'SELECT is_blocked, block_reason, license_expires_at FROM restaurants WHERE id = $1',
          [this.restaurantId]
        )
        row = result.rows[0]
      } catch {}
    }

    if (!row) return

    const isBlocked = row.is_blocked === true || row.is_blocked === 'true'
    const isExpired = row.license_expires_at && new Date(row.license_expires_at) < new Date()

    if (isBlocked || isExpired) {
      const reason = isExpired
        ? `Лицензия истекла ${new Date(row.license_expires_at).toLocaleDateString('ru')}. Обратитесь к администратору для продления.`
        : (row.block_reason || 'Заблокировано администратором')
      if (!this.wasBlocked) {
        this.wasBlocked = true
        console.log('[sync] License BLOCKED:', reason)
        if (this.onBlocked) this.onBlocked(reason)
      }
    } else if (this.wasBlocked) {
      this.wasBlocked = false
      console.log('[sync] License UNBLOCKED')
      if (this.onUnblocked) this.onUnblocked()
    }
  }

  // ─── PULL: Cloud → Local ──────────────────────────────────────────────────

  async pullFromCloud(initial = false) {
    if (this.syncing) return
    this.syncing = true
    console.log(`[sync] Pulling from cloud${initial ? ' (initial)' : ''}...`)
    const db = getDB()
    const tablesToPull = initial ? INITIAL_PULL_TABLES : PULL_TABLES

    try {
      for (const table of tablesToPull) {
        try {
          const filterCol = table === 'restaurants' ? 'id' : 'restaurant_id'
          // For tables without restaurant_id (tech_card_lines, etc), skip filter
          const noRestFilter = ['tech_card_lines', 'semi_recipe_lines', 'order_items', 'order_item_modifiers', 'stock_receipt_lines', 'stock_writeoff_lines', 'modifiers', 'cash_shift_operations']
          let url
          if (noRestFilter.includes(table)) {
            // These are child tables — pull all (they link via parent FK)
            // For large datasets, we'd need to join, but for now pull all
            url = `${this.supabaseUrl}/rest/v1/${table}?limit=10000`
          } else {
            url = `${this.supabaseUrl}/rest/v1/${table}?${filterCol}=eq.${this.restaurantId}&limit=10000`
          }

          const res = await fetch(url, {
            headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
          })
          if (!res.ok) continue
          const rows = await res.json()
          if (!Array.isArray(rows) || rows.length === 0) continue

          const columns = Object.keys(rows[0])

          // Auto-add missing columns
          for (const col of columns) {
            try {
              await db.query(`SELECT "${col}" FROM "${table}" LIMIT 0`)
            } catch {
              try {
                await db.query(`ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT`)
                console.log(`    [+] Added column ${table}.${col}`)
              } catch {}
            }
          }

          // Upsert each row — but DON'T overwrite if local version is newer (last-write-wins by updated_at)
          const hasUpdatedAt = columns.includes('updated_at')
          for (const row of rows) {
            const vals = columns.map(c => {
              const v = row[c]
              if (v === null || v === undefined) return null
              if (typeof v === 'object') return JSON.stringify(v)
              return v
            })
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(',')
            const colList = columns.map(c => `"${c}"`).join(',')
            const updateList = columns.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(',')

            // If table has updated_at, only update if cloud's version is newer than local
            const conflictCondition = hasUpdatedAt
              ? ` WHERE EXCLUDED.updated_at > "${table}".updated_at`
              : ''

            try {
              await db.query(
                `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updateList}${conflictCondition}`,
                vals
              )
            } catch (e) {
              try { await db.query(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, vals) } catch {}
            }
          }

          console.log(`  [sync] ${table}: ${rows.length} rows`)
        } catch (err) {
          console.error(`  [sync] ${table} failed:`, err.message)
        }
      }

      // Update last pull timestamp
      await db.query(`INSERT INTO sync_meta (table_name, last_pulled_at) VALUES ('_all', now()) ON CONFLICT (table_name) DO UPDATE SET last_pulled_at = now()`)

      await this.checkBlocked()
    } finally {
      this.syncing = false
    }
    console.log('[sync] Pull complete')
  }

  // ─── PUSH: Local → Cloud ──────────────────────────────────────────────────

  async pushToCloud() {
    const db = getDB()
    console.log('[sync] Pushing to cloud...')

    for (const table of PUSH_TABLES) {
      try {
        // Get last push time for this table
        const metaResult = await db.query(
          `SELECT last_synced_at FROM sync_meta WHERE table_name = $1`,
          [table]
        )
        const lastSync = metaResult.rows[0]?.last_synced_at || '1970-01-01T00:00:00Z'

        // Find rows modified after last sync
        // Use updated_at if available, otherwise created_at
        let rows
        try {
          const result = await db.query(
            `SELECT * FROM "${table}" WHERE updated_at > $1 OR created_at > $1`,
            [lastSync]
          )
          rows = result.rows
        } catch {
          // Table might not have updated_at
          try {
            const result = await db.query(
              `SELECT * FROM "${table}" WHERE created_at > $1`,
              [lastSync]
            )
            rows = result.rows
          } catch {
            continue
          }
        }

        if (!rows || rows.length === 0) continue

        // Columns that should ALWAYS be stripped before pushing — either generated
        // columns in cloud (Postgres rejects writes), or legacy local columns that
        // never existed in cloud schema.
        const STRIP_COLS = {
          liabilities: ['remaining_amount'],   // GENERATED ALWAYS AS (total - paid)
          assets: ['depreciation_rate', 'value'],  // legacy local-only columns
          stock_writeoffs: ['note'],           // legacy; cloud has 'description'
          stock_movements: ['ingredient_name'], // local denorm
          stock_receipts: ['supplier_name'],    // local denorm
          users: ['email', 'phone'],            // local-only extra fields
        }

        // Upsert to Supabase (POST with on_conflict)
        // Supabase PostgREST supports upsert via Prefer: resolution=merge-duplicates
        let allBatchesOk = true
        const batchSize = 100
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize).map(row => {
            const clean = { ...row }
            // Strip known-bad columns
            const stripList = STRIP_COLS[table] || []
            for (const c of stripList) delete clean[c]
            // Ensure restaurant_id is set
            if (!clean.restaurant_id && table !== 'restaurants') {
              clean.restaurant_id = this.restaurantId
            }
            // Serialize JSONB fields
            for (const [k, v] of Object.entries(clean)) {
              if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
                clean[k] = JSON.stringify(v)
              }
            }
            return clean
          })

          // Try push, on schema error retry without the unknown column
          let attempt = 0
          let currentBatch = batch
          let batchOk = false
          while (attempt < 5) {
            try {
              const res = await fetch(`${this.supabaseUrl}/rest/v1/${table}`, {
                method: 'POST',
                headers: {
                  apikey: this.supabaseKey,
                  Authorization: `Bearer ${this.supabaseKey}`,
                  'Content-Type': 'application/json',
                  Prefer: 'resolution=merge-duplicates',
                },
                body: JSON.stringify(currentBatch),
              })
              if (res.ok) { batchOk = true; break }
              const errText = await res.text()
              // Detect missing column error and remove it from all rows, then retry
              const m = errText.match(/Could not find the '([^']+)' column/)
              if (m && attempt < 4) {
                const badCol = m[1]
                console.log(`  [push] ${table}: removing unknown column '${badCol}' and retrying`)
                currentBatch = currentBatch.map(r => { const c = { ...r }; delete c[badCol]; return c })
                attempt++
                continue
              }
              console.error(`  [push] ${table} batch failed:`, errText.slice(0, 200))
              break
            } catch (err) {
              console.error(`  [push] ${table} network error:`, err.message)
              break
            }
          }
          if (!batchOk) allBatchesOk = false
        }

        // Update sync timestamp ONLY if all batches succeeded
        if (allBatchesOk) {
          await db.query(
            `INSERT INTO sync_meta (table_name, last_synced_at) VALUES ($1, now()) ON CONFLICT (table_name) DO UPDATE SET last_synced_at = now()`,
            [table]
          )
          console.log(`  [push] ${table}: ${rows.length} rows ✓`)
        } else {
          console.log(`  [push] ${table}: failed, will retry`)
        }
      } catch (err) {
        console.error(`  [push] ${table} error:`, err.message)
      }
    }
    console.log('[sync] Push complete')
  }

  // ─── Start sync loop ──────────────────────────────────────────────────────

  // Fast pull of only the most time-sensitive tables (table status, orders).
  // Keeps table-map and orders page responsive between full pulls.
  async pullHotTables() {
    if (this.syncing) return
    const db = getDB()
    const HOT = ['tables', 'orders', 'order_items']
    try {
      for (const table of HOT) {
        try {
          const filterCol = 'restaurant_id'
          const noRest = ['order_items']
          const url = noRest.includes(table)
            ? `${this.supabaseUrl}/rest/v1/${table}?limit=10000`
            : `${this.supabaseUrl}/rest/v1/${table}?${filterCol}=eq.${this.restaurantId}&limit=10000`
          const res = await fetch(url, {
            headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
            signal: AbortSignal.timeout(5000),
          })
          if (!res.ok) continue
          const rows = await res.json()
          if (!Array.isArray(rows) || rows.length === 0) continue
          const columns = Object.keys(rows[0])
          const hasUpdatedAt = columns.includes('updated_at')
          for (const row of rows) {
            const vals = columns.map(c => {
              const v = row[c]
              if (v === null || v === undefined) return null
              if (typeof v === 'object') return JSON.stringify(v)
              return v
            })
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(',')
            const colList = columns.map(c => `"${c}"`).join(',')
            const updateList = columns.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(',')
            const conflictCondition = hasUpdatedAt ? ` WHERE EXCLUDED.updated_at > "${table}".updated_at` : ''
            try {
              await db.query(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updateList}${conflictCondition}`, vals)
            } catch { try { await db.query(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, vals) } catch {} }
          }
        } catch {}
      }
    } catch {}
  }

  start() {
    // Initial full pull after 3 seconds
    setTimeout(() => this.pullFromCloud().catch(() => {}), 3000)

    // Fast push loop (every 3 sec) — sends local changes to cloud quickly
    setInterval(async () => {
      try {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/restaurants?limit=1`, {
          headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          await this.pushToCloud()
        }
      } catch {}
    }, 3000)

    // Fast pull of hot tables (every 5 sec) — tables + orders only
    // Keeps table-map responsive (<5 sec latency between devices)
    // Also checks block/license status every cycle for real-time enforcement.
    setInterval(async () => {
      try {
        await this.pullHotTables()
        await this.checkBlocked()
      } catch {}
    }, 5000)

    // Full pull (every 30 sec) — all tables including reference data
    setInterval(async () => {
      try {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/restaurants?limit=1`, {
          headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          await this.pullFromCloud()
          await this.sendHeartbeat()
        } else {
          console.log('[sync] Offline — skipping pull')
        }
      } catch {
        console.log('[sync] Offline — skipping pull')
      }
    }, 30000)

    console.log('[sync] Started (push: 3s, hot-pull: 5s, full-pull: 30s)')
  }
}

module.exports = { SyncEngine }
