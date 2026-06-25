// db/database.js — Base original que funcionaba + tablas plataforma CRM
const { Database: RawDB } = require('node-sqlite3-wasm');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'ree_app.db');
let instance;

class DB {
  constructor(filePath) {
    this._db = new RawDB(filePath);

    try {
      this._db.exec('PRAGMA busy_timeout = 15000');
    } catch (error) {}

    try {
      this._db.exec('PRAGMA foreign_keys = ON');
    } catch (error) {}
  }

  _isLockedError(error) {
    const message = String(error?.message || error || '').toLowerCase();

    return (
      message.includes('database is locked') ||
      message.includes('sqlite_busy') ||
      message.includes('database locked') ||
      message.includes('busy')
    );
  }

  _sleep(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (error) {
      const start = Date.now();
      while (Date.now() - start < ms) {}
    }
  }

  _withRetry(fn, label = 'db') {
    let lastError;

    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        return fn();
      } catch (error) {
        lastError = error;

        if (!this._isLockedError(error)) {
          throw error;
        }

        const wait = Math.min(250 * attempt, 2000);
        console.warn(`[database] ${label} bloqueado. Reintentando ${attempt}/8 en ${wait}ms...`);
        this._sleep(wait);
      }
    }

    throw lastError;
  }

  _finalizeStatement(stmt) {
    try {
      if (stmt && typeof stmt.finalize === 'function') {
        stmt.finalize();
      } else if (stmt && typeof stmt.free === 'function') {
        stmt.free();
      }
    } catch (error) {}
  }

  _toArr(args) {
    if (args.length === 0) return [];
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return args;
  }

  exec(sql) {
    return this._withRetry(() => this._db.exec(sql), 'exec');
  }

  prepare(sql) {
    const self = this;
    const raw = this._db;

    return {
      get: (...args) => {
        return self._withRetry(() => {
          const stmt = raw.prepare(sql);

          try {
            return stmt.get(self._toArr(args));
          } finally {
            self._finalizeStatement(stmt);
          }
        }, 'prepare.get');
      },

      all: (...args) => {
        return self._withRetry(() => {
          const stmt = raw.prepare(sql);

          try {
            return stmt.all(self._toArr(args));
          } finally {
            self._finalizeStatement(stmt);
          }
        }, 'prepare.all');
      },

      run: (...args) => {
        return self._withRetry(() => {
          const stmt = raw.prepare(sql);

          try {
            return stmt.run(self._toArr(args));
          } finally {
            self._finalizeStatement(stmt);
          }
        }, 'prepare.run');
      }
    };
  }

  get(sql, ...args) {
    return this.prepare(sql).get(...args);
  }

  run(sql, ...args) {
    return this.prepare(sql).run(...args);
  }

  all(sql, ...args) {
    return this.prepare(sql).all(...args);
  }
}

function getDb() {
  if (!instance) {
    instance = new DB(DB_PATH);

    try {
      instance.exec('PRAGMA journal_mode = DELETE');
    } catch (error) {}

    try {
      instance.exec('PRAGMA synchronous = NORMAL');
    } catch (error) {}

    try {
      instance.exec('PRAGMA busy_timeout = 15000');
    } catch (error) {}

    try {
      instance.exec('PRAGMA foreign_keys = ON');
    } catch (error) {}

    initSchema();
  }

  return instance;
}

function initSchema() {
  const db = instance;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, slug TEXT, parent_id INTEGER, wp_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, logo TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, short_description TEXT, description TEXT,
      brand_id INTEGER, category_id INTEGER, model TEXT,
      type TEXT DEFAULT 'simple', sku TEXT, price REAL, sale_price REAL,
      stock_quantity INTEGER DEFAULT 0, stock_status TEXT DEFAULT 'instock',
      youtube_url TEXT, pdf_filename TEXT, seo_keyword TEXT,
      seo_title TEXT, seo_description TEXT, status TEXT DEFAULT 'draft',
      wp_product_id INTEGER, created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL, filename TEXT NOT NULL,
      is_main INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS product_attributes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, action TEXT NOT NULL, entity TEXT,
      entity_id INTEGER, details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS knowledge_guides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, topic TEXT, content TEXT DEFAULT '',
      author TEXT, guide_type TEXT DEFAULT 'general', is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS guide_instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guide_id INTEGER, instruction TEXT NOT NULL, order_index INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS guide_qa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guide_id INTEGER, question TEXT NOT NULL, answer TEXT NOT NULL,
      order_index INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, last_name TEXT, phone TEXT, email TEXT,
      channel TEXT DEFAULT 'manual', notes TEXT, wa_id TEXT, created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS client_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, color TEXT DEFAULT '#3b82f6',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS client_label_assignments (
      client_id INTEGER, label_id INTEGER, PRIMARY KEY (client_id, label_id)
    );
    CREATE TABLE IF NOT EXISTS sales_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT DEFAULT 'manual', is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS taxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, rate REAL NOT NULL, is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT, client_id INTEGER, client_name TEXT, client_phone TEXT,
      currency TEXT DEFAULT 'DOP', status TEXT DEFAULT 'pending',
      payment_status TEXT DEFAULT 'pending', channel_id INTEGER, channel_name TEXT,
      vendor_id INTEGER, vendor_name TEXT, subtotal REAL DEFAULT 0,
      tax_total REAL DEFAULT 0, discount REAL DEFAULT 0, total REAL DEFAULT 0,
      notes TEXT, terms_accepted INTEGER DEFAULT 0, created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER, product_id INTEGER, product_name TEXT NOT NULL,
      sku TEXT, quantity INTEGER DEFAULT 1, price REAL DEFAULT 0,
      tax_id INTEGER, tax_rate REAL DEFAULT 0, subtotal REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER, client_name TEXT, client_phone TEXT,
      channel TEXT DEFAULT 'whatsapp', status TEXT DEFAULT 'open',
      assigned_agent_id INTEGER, is_ai_managed INTEGER DEFAULT 0,
      has_purchase_intent INTEGER DEFAULT 0, needs_human INTEGER DEFAULT 0,
      last_message TEXT, last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      unread_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER, sender_type TEXT DEFAULT 'client',
      sender_name TEXT, content TEXT, message_type TEXT DEFAULT 'text',
      media_url TEXT, is_read INTEGER DEFAULT 0,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, name TEXT NOT NULL, last_name TEXT, email TEXT,
      username TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'vendedor',
      status TEXT DEFAULT 'available', team_id INTEGER,
      avatar_color TEXT DEFAULT '#3b82f6',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER, client_name TEXT, message TEXT NOT NULL,
      channel TEXT DEFAULT 'whatsapp', scheduled_at DATETIME,
      status TEXT DEFAULT 'pending', created_by TEXT, sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, message TEXT NOT NULL,
      target_labels TEXT DEFAULT '[]', channel TEXT DEFAULT 'whatsapp',
      scheduled_at DATETIME, status TEXT DEFAULT 'draft',
      sent_count INTEGER DEFAULT 0, created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS message_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT DEFAULT 'quick_reply',
      category TEXT DEFAULT 'MARKETING', text_content TEXT NOT NULL,
      is_active INTEGER DEFAULT 1, status TEXT DEFAULT 'approved',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      category TEXT DEFAULT 'messaging', config TEXT DEFAULT '{}',
      is_connected INTEGER DEFAULT 0, webhook_url TEXT,
      connected_at DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS commerce_info (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const admin = db.get('SELECT id FROM users WHERE role=?', 'superadmin');
  if (!admin) {
    const hash = bcrypt.hashSync('Admin2024!', 10);
    db.run('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)',
      'Super Admin', 'ivarytech@gmail.com', hash, 'superadmin');
    console.log('✅ Superadmin: ivarytech@gmail.com / Admin2024!');
  }
  const cc = db.get('SELECT COUNT(*) as c FROM categories');
  if (cc.c === 0) {
    ['Breakers','Cables','Contactores','Iluminacion','Motores','Sensores','Tableros','Transformadores']
      .forEach(n => db.run('INSERT INTO categories(name,slug) VALUES(?,?)', n, n.toLowerCase()));
  }
  const bc = db.get('SELECT COUNT(*) as c FROM brands');
  if (bc.c === 0) {
    ['ABB','Schneider Electric','Siemens','Legrand','Eaton','General Electric']
      .forEach(n => db.run('INSERT INTO brands(name) VALUES(?)', n));
  }
  try {
    const sc = db.get('SELECT COUNT(*) as c FROM sales_channels');
    if (sc.c === 0) ['WhatsApp','Instagram','Facebook','Presencial','Teléfono','WooCommerce']
      .forEach(n => db.run('INSERT INTO sales_channels(name) VALUES(?)', n));
  } catch {}
  try {
    const tc = db.get('SELECT COUNT(*) as c FROM taxes');
    if (tc.c === 0) db.run("INSERT INTO taxes(name,rate) VALUES('ITBIS 18%',18)");
  } catch {}
  try {
    const lc = db.get('SELECT COUNT(*) as c FROM client_labels');
    if (lc.c === 0) [['Lead nuevo','#3b82f6'],['Cliente fiel','#22c55e'],['Interesado','#f59e0b'],['No contactar','#ef4444']]
      .forEach(([n,c]) => db.run('INSERT INTO client_labels(name,color) VALUES(?,?)', n, c));
  } catch {}
  try {
    [['whatsapp','WhatsApp Business','whatsapp','messaging'],
     ['messenger','Facebook Messenger','messenger','messaging'],
     ['instagram_dm','Instagram DM','instagram_dm','messaging'],
     ['claude_ai','Claude AI','claude','ai'],
     ['openai','ChatGPT (OpenAI)','openai','ai']]
    .forEach(([id,name,type,cat]) => {
      try { db.run('INSERT OR IGNORE INTO integrations(id,name,type,category) VALUES(?,?,?,?)',id,name,type,cat); } catch {}
    });
  } catch {}
}

module.exports = { getDb };
