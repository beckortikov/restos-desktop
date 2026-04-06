const { PGlite } = require('@electric-sql/pglite')
const path = require('path')
const fs = require('fs')

// Store DB in user data folder
function getDataDir() {
  try { const { app } = require('electron'); return path.join(app.getPath('userData'), 'pgdata') }
  catch { return path.join(__dirname, 'data', 'pgdata') }
}
const DB_DIR = getDataDir()
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

let db = null

async function initDB() {
  db = new PGlite(DB_DIR)

  // Create all tables — identical to Supabase schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT,
      logo_url TEXT,
      address TEXT,
      phone TEXT,
      currency TEXT DEFAULT 'TJS',
      service_percent NUMERIC DEFAULT 10,
      timezone TEXT DEFAULT 'Asia/Dushanbe',
      enforce_stock_check BOOLEAN DEFAULT false,
      local_server_ip TEXT,
      license_key TEXT,
      is_blocked BOOLEAN DEFAULT false,
      block_reason TEXT,
      last_seen_at TIMESTAMPTZ,
      app_version TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT,
      password TEXT DEFAULT '1234',
      name TEXT,
      role TEXT DEFAULT 'waiter',
      restaurant_id TEXT,
      phone TEXT,
      email TEXT,
      position TEXT,
      birth_date TEXT,
      station TEXT,
      shift_number INTEGER,
      salary NUMERIC DEFAULT 0,
      permissions JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS zones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tables (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      number INTEGER,
      name TEXT,
      capacity INTEGER DEFAULT 4,
      zone_id TEXT,
      status TEXT DEFAULT 'free',
      current_order_id TEXT,
      waiter_id TEXT,
      opened_at TIMESTAMPTZ,
      merged_with TEXT,
      original_capacity INTEGER,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      price NUMERIC DEFAULT 0,
      emoji TEXT DEFAULT '',
      image_url TEXT,
      is_available BOOLEAN DEFAULT true,
      stop_list_override BOOLEAN DEFAULT false,
      cogs NUMERIC DEFAULT 0,
      cook_time_min INTEGER,
      station TEXT DEFAULT 'hot_kitchen',
      is_batch_cooking BOOLEAN DEFAULT false,
      prepared_qty INTEGER DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tech_card_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      menu_item_id UUID,
      ingredient_id UUID,
      semi_fab_type_id UUID,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT
    );

    CREATE TABLE IF NOT EXISTS ingredients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      qty NUMERIC DEFAULT 0,
      min_qty NUMERIC DEFAULT 0,
      unit TEXT,
      price_per_unit NUMERIC DEFAULT 0,
      waste_percent NUMERIC DEFAULT 0,
      is_food BOOLEAN DEFAULT true,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number SERIAL,
      status TEXT DEFAULT 'new',
      type TEXT DEFAULT 'hall',
      table_id TEXT,
      waiter_id TEXT,
      cashier_id TEXT,
      payment_method TEXT,
      comment TEXT,
      total NUMERIC DEFAULT 0,
      service_percent NUMERIC DEFAULT 0,
      service_amount NUMERIC DEFAULT 0,
      total_with_service NUMERIC DEFAULT 0,
      guests_count INTEGER DEFAULT 1,
      tip_amount NUMERIC DEFAULT 0,
      payments JSONB DEFAULT '[]',
      discount_type TEXT,
      discount_value NUMERIC DEFAULT 0,
      discount_amount NUMERIC DEFAULT 0,
      discount_reason TEXT,
      is_split BOOLEAN DEFAULT false,
      split_count INTEGER DEFAULT 0,
      shift_id TEXT,
      restaurant_id TEXT,
      ready_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID,
      menu_item_id UUID,
      name TEXT,
      qty INTEGER DEFAULT 1,
      price NUMERIC DEFAULT 0,
      cogs NUMERIC DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_item_modifiers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_item_id UUID,
      modifier_id UUID,
      name TEXT,
      price NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS financial_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      type TEXT DEFAULT 'cash',
      balance NUMERIC DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS financial_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT,
      amount NUMERIC DEFAULT 0,
      category TEXT,
      account_id TEXT,
      account_name TEXT,
      activity TEXT DEFAULT 'operational',
      date TEXT,
      description TEXT,
      counterparty TEXT,
      is_auto BOOLEAN DEFAULT false,
      source_ref TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT,
      ingredient_id TEXT,
      ingredient_name TEXT,
      description TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      below_zero BOOLEAN DEFAULT false,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      "timestamp" TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      contact_person TEXT,
      phone TEXT,
      categories JSONB,
      payment_terms_days INTEGER DEFAULT 0,
      credit_limit NUMERIC DEFAULT 0,
      current_debt NUMERIC DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id TEXT,
      supplier_name TEXT,
      date TEXT,
      note TEXT,
      total_amount NUMERIC DEFAULT 0,
      payment_type TEXT DEFAULT 'paid',
      paid_amount NUMERIC DEFAULT 0,
      debt_amount NUMERIC DEFAULT 0,
      due_date TEXT,
      confirmed_at TIMESTAMPTZ,
      confirmed_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_receipt_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      receipt_id UUID,
      ingredient_id TEXT,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      price_per_unit NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cash_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      opened_by TEXT,
      closed_by TEXT,
      opening_balance NUMERIC DEFAULT 0,
      closing_balance NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'open',
      opened_at TIMESTAMPTZ DEFAULT now(),
      closed_at TIMESTAMPTZ,
      restaurant_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cash_shift_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shift_id UUID,
      type TEXT,
      amount NUMERIC DEFAULT 0,
      description TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id TEXT,
      guest_name TEXT,
      guest_phone TEXT,
      guests_count INTEGER DEFAULT 2,
      reserved_at TIMESTAMPTZ,
      duration_min INTEGER DEFAULT 120,
      status TEXT DEFAULT 'pending',
      note TEXT,
      created_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      phone TEXT,
      email TEXT,
      birth_date TEXT,
      notes TEXT,
      visits_count INTEGER DEFAULT 0,
      total_spent NUMERIC DEFAULT 0,
      avg_check NUMERIC DEFAULT 0,
      last_visit_at TIMESTAMPTZ,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_voids (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID,
      item_name TEXT,
      item_qty INTEGER DEFAULT 1,
      item_price NUMERIC DEFAULT 0,
      reason TEXT,
      approved_by_name TEXT,
      created_by_name TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_splits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID,
      split_number INTEGER,
      items JSONB,
      total NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'pending',
      payment_method TEXT,
      paid_at TIMESTAMPTZ,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS modifier_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      menu_item_id UUID,
      is_required BOOLEAN DEFAULT false,
      max_select INTEGER DEFAULT 1,
      restaurant_id TEXT
    );

    CREATE TABLE IF NOT EXISTS modifiers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID,
      name TEXT,
      price NUMERIC DEFAULT 0,
      is_default BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS semi_finished_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      output_unit TEXT DEFAULT 'кг',
      yield_percent NUMERIC DEFAULT 100,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS semi_recipe_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semi_type_id UUID,
      ingredient_id UUID,
      name TEXT,
      qty_per_unit NUMERIC DEFAULT 0,
      unit TEXT
    );

    CREATE TABLE IF NOT EXISTS semi_finished_stock (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semi_type_id UUID,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      price_per_unit NUMERIC DEFAULT 0,
      last_produced_at TIMESTAMPTZ,
      restaurant_id TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_writeoffs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reason TEXT,
      total_cost NUMERIC DEFAULT 0,
      note TEXT,
      created_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS writeoff_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      writeoff_id UUID,
      ingredient_id TEXT,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      cost NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS batch_cooking_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      menu_item_id UUID,
      menu_item_name TEXT,
      qty INTEGER DEFAULT 0,
      produced_by TEXT,
      produced_by_id UUID,
      cost_total NUMERIC DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS supply_expenses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id UUID,
      ingredient_name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      reason TEXT,
      issued_to TEXT,
      note TEXT,
      created_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      clock_in TIMESTAMPTZ,
      clock_out TIMESTAMPTZ,
      break_minutes INTEGER DEFAULT 0,
      total_hours NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'active',
      note TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      value NUMERIC DEFAULT 0,
      purchase_date TEXT,
      depreciation_rate NUMERIC DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS liabilities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      type TEXT,
      total_amount NUMERIC DEFAULT 0,
      remaining_amount NUMERIC DEFAULT 0,
      monthly_payment NUMERIC DEFAULT 0,
      due_date TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS equity (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      type TEXT,
      amount NUMERIC DEFAULT 0,
      date TEXT,
      description TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS budget_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category TEXT,
      type TEXT,
      plan_amount NUMERIC DEFAULT 0,
      fact_amount NUMERIC DEFAULT 0,
      period TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      entity_name TEXT,
      details JSONB,
      user_id TEXT,
      user_name TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      table_name TEXT PRIMARY KEY,
      last_synced_at TIMESTAMPTZ,
      last_pulled_at TIMESTAMPTZ
    );
  `)

  console.log('  [DB] PostgreSQL (PGlite) initialized')
  return db
}

function getDB() {
  return db
}

const DB_PATH = DB_DIR

module.exports = { initDB, getDB, DB_PATH }
