const express = require('express')
const router = express.Router()
const https = require('https')
const http = require('http')
const { authMiddleware, requireRole } = require('../middleware/auth')
const { getDb } = require('../database')

// --- Seed default integrations if not exist ---
const DEFAULT_INTEGRATIONS = [
  { name: 'WhatsApp Business', type: 'whatsapp', category: 'messaging' },
  { name: 'Messenger', type: 'messenger', category: 'messaging' },
  { name: 'Instagram DM', type: 'instagram_dm', category: 'social' },
  { name: 'Instagram Comments', type: 'instagram_comments', category: 'social' },
  { name: 'Facebook Comments', type: 'facebook_comments', category: 'social' },
  { name: 'ChatGPT / OpenAI', type: 'openai', category: 'ai' },
  { name: 'Claude AI (Anthropic)', type: 'claude_ai', category: 'ai' },
  { name: 'DALL·E 3 (Imágenes)', type: 'dalle3', category: 'image_gen' },
  { name: 'WooCommerce REST API', type: 'woocommerce', category: 'ecommerce' },
  { name: 'Meta Ads', type: 'meta_ads', category: 'advertising' },
  { name: 'Google Ads', type: 'google_ads', category: 'advertising' },
]

function ensureIntegrationsTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT UNIQUE NOT NULL,
      category TEXT DEFAULT 'other',
      is_connected INTEGER DEFAULT 0,
      config TEXT,
      connected_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run()
  // Seed defaults
  for (const d of DEFAULT_INTEGRATIONS) {
    const exists = db.prepare('SELECT id FROM integrations WHERE type=?').get(d.type)
    if (!exists) {
      db.prepare('INSERT INTO integrations (name,type,category) VALUES (?,?,?)').run(d.name, d.type, d.category)
    }
  }
}

function getConfig(row) {
  if (!row || !row.config) return {}
  try { return JSON.parse(row.config) } catch { return {} }
}

// Simple HTTP/S request helper
function httpReq(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: 10000,
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(d)) } catch { resolve(d) }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Tiempo de espera agotado')) })
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

// Test a specific integration type
async function runTest(type, config) {
  if (type === 'openai') {
    const data = await httpReq('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${config.api_key}` }
    })
    return `OpenAI conectado. ${data.data?.length || 0} modelos disponibles.`
  }
  if (type === 'claude_ai') {
    // Simple ping to Anthropic
    await httpReq('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': config.api_key, 'anthropic-version': '2023-06-01' }
    })
    return 'Claude AI conectado correctamente.'
  }
  if (type === 'dalle3') {
    const data = await httpReq('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${config.api_key}` }
    })
    const hasDalle = data.data?.some(m => m.id?.includes('dall-e'))
    return hasDalle ? 'DALL·E 3 disponible en tu cuenta.' : 'OpenAI conectado (verifica acceso a DALL·E).'
  }
  if (type === 'woocommerce') {
    const base = (config.woo_url || config.url || '').replace(/\/$/, '')
    const key = config.woo_key || config.consumer_key
    const secret = config.woo_secret || config.consumer_secret
    if (!base || !key || !secret) throw new Error('Faltan credenciales de WooCommerce')
    const auth = Buffer.from(`${key}:${secret}`).toString('base64')
    const data = await httpReq(`${base}/wp-json/wc/v3/products?per_page=1`, {
      headers: { 'Authorization': `Basic ${auth}` }
    })
    return `WooCommerce conectado. API funcionando correctamente.`
  }
  if (type === 'whatsapp') {
    if (!config.access_token || !config.phone_number_id) throw new Error('Falta token o Phone Number ID')
    const data = await httpReq(
      `https://graph.facebook.com/v18.0/${config.phone_number_id}`,
      { headers: { 'Authorization': `Bearer ${config.access_token}` } }
    )
    return `WhatsApp conectado. Número: ${data.display_phone_number || data.id}`
  }
  // Generic: just confirm config was saved
  return 'Configuración guardada. No hay prueba automática para este tipo.'
}

// GET /api/integrations
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDb()
    ensureIntegrationsTable(db)
    const rows = db.prepare('SELECT * FROM integrations ORDER BY category, name').all()
    res.json(rows.map(r => ({ ...r, config: getConfig(r), is_connected: !!r.is_connected })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/integrations/:id — save config
router.put('/:id', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb()
    ensureIntegrationsTable(db)
    const { config } = req.body || {}
    db.prepare('UPDATE integrations SET config=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify(config || {}), req.params.id)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/integrations/:id/connect — save + mark connected
router.post('/:id/connect', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb()
    ensureIntegrationsTable(db)
    const { config } = req.body || {}
    db.prepare('UPDATE integrations SET config=?, is_connected=1, connected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify(config || {}), req.params.id)
    res.json({ success: true, message: 'Integración conectada' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/integrations/:id/disconnect
router.post('/:id/disconnect', authMiddleware, requireRole('admin', 'superadmin'), (req, res) => {
  try {
    const db = getDb()
    ensureIntegrationsTable(db)
    db.prepare('UPDATE integrations SET is_connected=0, config=NULL, connected_at=NULL WHERE id=?').run(req.params.id)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/integrations/:id/test — test the connection
router.post('/:id/test', authMiddleware, async (req, res) => {
  try {
    const db = getDb()
    ensureIntegrationsTable(db)
    const row = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id)
    if (!row) return res.status(404).json({ error: 'Integración no encontrada' })
    const config = getConfig(row)
    const message = await runTest(row.type, config)
    // Mark as connected after successful test
    db.prepare('UPDATE integrations SET is_connected=1, connected_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id)
    res.json({ success: true, message })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

module.exports = router
