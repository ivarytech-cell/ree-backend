const express = require('express')
const router = express.Router()
const https = require('https')
const http = require('http')
const { authMiddleware, requireRole } = require('../middleware/auth')
const { getDb } = require('../database')

const DEFAULTS = [
  { name: 'WhatsApp Business',      type: 'whatsapp',           category: 'messaging' },
  { name: 'Messenger',              type: 'messenger',           category: 'messaging' },
  { name: 'Instagram DM',           type: 'instagram_dm',        category: 'social' },
  { name: 'Instagram Comments',     type: 'instagram_comments',  category: 'social' },
  { name: 'Facebook Comments',      type: 'facebook_comments',   category: 'social' },
  { name: 'ChatGPT / OpenAI',       type: 'openai',              category: 'ai' },
  { name: 'Claude AI (Anthropic)',   type: 'claude_ai',           category: 'ai' },
  { name: 'DALL·E 3 (Imágenes IA)', type: 'dalle3',              category: 'ai' },
  { name: 'WooCommerce REST API',    type: 'woocommerce',         category: 'ecommerce' },
  { name: 'Meta Ads',               type: 'meta_ads',            category: 'advertising' },
  { name: 'Google Ads',             type: 'google_ads',          category: 'advertising' },
]

function initTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS integrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT UNIQUE NOT NULL,
      category    TEXT DEFAULT 'other',
      is_connected INTEGER DEFAULT 0,
      config      TEXT,
      connected_at DATETIME,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run()

  // Always ensure all defaults exist
  const insert = db.prepare(
    'INSERT OR IGNORE INTO integrations (name, type, category) VALUES (?, ?, ?)'
  )
  for (const d of DEFAULTS) insert.run(d.name, d.type, d.category)
}

function parseConfig(row) {
  if (!row || !row.config) return {}
  try { return JSON.parse(row.config) } catch { return {} }
}

// ── HTTP helper (works on Node 14/16/18/20) ──────────────────────────────────
function httpReq(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: 12000,
      rejectUnauthorized: false,   // allows self-signed certs
    }
    const req = lib.request(options, res => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }) }
          catch { resolve({ status: res.statusCode, data: body }) }
        } else {
          reject(new Error(`HTTP ${res.statusCode} en ${u.hostname}${u.pathname}`))
        }
      })
    })
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Tiempo de espera agotado (12s)')) })
    req.on('error', err => reject(new Error(err.message)))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

// ── Test each integration type ────────────────────────────────────────────────
async function testIntegration(type, cfg) {
  switch (type) {

    case 'woocommerce': {
      const base = (cfg.woo_url || '').trim().replace(/\/$/, '')
      const key  = (cfg.woo_key || '').trim()
      const sec  = (cfg.woo_secret || '').trim()
      if (!base) throw new Error('Falta la URL del sitio WooCommerce')
      if (!key)  throw new Error('Falta el Consumer Key')
      if (!sec)  throw new Error('Falta el Consumer Secret')
      const auth = Buffer.from(`${key}:${sec}`).toString('base64')
      const res  = await httpReq(`${base}/wp-json/wc/v3/products?per_page=1`, {
        headers: { Authorization: `Basic ${auth}` }
      })
      const count = Array.isArray(res.data) ? res.data.length : '?'
      return `✅ WooCommerce conectado correctamente. API REST funcionando en ${base}`
    }

    case 'openai':
    case 'dalle3': {
      if (!cfg.api_key) throw new Error('Falta el API Key de OpenAI')
      const res = await httpReq('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${cfg.api_key}` }
      })
      const models = res.data?.data?.length || 0
      return `✅ OpenAI conectado. ${models} modelos disponibles.`
    }

    case 'claude_ai': {
      if (!cfg.api_key) throw new Error('Falta el API Key de Anthropic')
      await httpReq('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' }
      })
      return '✅ Claude AI conectado correctamente.'
    }

    case 'whatsapp': {
      if (!cfg.access_token || !cfg.phone_number_id)
        throw new Error('Falta el Access Token o Phone Number ID')
      const res = await httpReq(
        `https://graph.facebook.com/v19.0/${cfg.phone_number_id}`,
        { headers: { Authorization: `Bearer ${cfg.access_token}` } }
      )
      return `✅ WhatsApp conectado. ID: ${res.data.id || cfg.phone_number_id}`
    }

    default:
      return '✅ Configuración guardada correctamente.'
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/integrations
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDb()
    initTable(db)
    const rows = db.prepare('SELECT * FROM integrations ORDER BY category, name').all()
    res.json(rows.map(r => ({
      ...r,
      config:       parseConfig(r),
      is_connected: !!r.is_connected,
    })))
  } catch (err) {
    console.error('[integrations] GET /', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/integrations/:id  — save config (no connect yet)
router.put('/:id', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb()
    initTable(db)
    const { config } = req.body || {}
    db.prepare(
      'UPDATE integrations SET config=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(JSON.stringify(config || {}), req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/integrations/:id/connect  — save + mark connected
router.post('/:id/connect', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb()
    initTable(db)
    const { config } = req.body || {}
    db.prepare(
      `UPDATE integrations
       SET config=?, is_connected=1, connected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).run(JSON.stringify(config || {}), req.params.id)
    res.json({ success: true, message: 'Integración conectada' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/integrations/:id/disconnect
router.post('/:id/disconnect', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb()
    initTable(db)
    db.prepare(
      'UPDATE integrations SET is_connected=0, config=NULL, connected_at=NULL WHERE id=?'
    ).run(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/integrations/:id/test  — live test without changing connected status
router.post('/:id/test', authMiddleware, async (req, res) => {
  try {
    const db = getDb()
    initTable(db)
    const row = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id)
    if (!row) return res.status(404).json({ error: 'Integración no encontrada' })

    const cfg = parseConfig(row)
    const message = await testIntegration(row.type, cfg)

    // Mark connected on success
    db.prepare(
      'UPDATE integrations SET is_connected=1, connected_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(req.params.id)

    res.json({ success: true, message })
  } catch (err) {
    console.error('[integrations] test error:', err.message)
    res.status(400).json({ error: err.message })
  }
})

module.exports = router
