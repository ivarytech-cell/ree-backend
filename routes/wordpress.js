const express = require('express')
const router = express.Router()
const { authMiddleware, requireRole } = require('../middleware/auth')
const { getDb } = require('../database')

// Helper: get WooCommerce config from DB
function getWooConfig(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'woocommerce_config'").get()
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return null }
}

// Helper: test WooCommerce connection
async function testWooConnection(config) {
  const { woo_url, woo_key, woo_secret } = config
  if (!woo_url || !woo_key || !woo_secret) throw new Error('Faltan credenciales')
  const url = `${woo_url.replace(/\/$/, '')}/wp-json/wc/v3/system_status`
  const credentials = Buffer.from(`${woo_key}:${woo_secret}`).toString('base64')
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' }
  })
  if (!res.ok) throw new Error(`WooCommerce respondió ${res.status}`)
  return await res.json()
}

// GET /api/wordpress/status - retorna config actual y estado de conexión
router.get('/status', authMiddleware, (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.json({ connected: false, woo_url: null })
    res.json({
      connected: true,
      woo_url: config.woo_url,
      has_key: !!config.woo_key,
      has_secret: !!config.woo_secret,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/config - guarda y prueba la conexión WooCommerce
router.post('/config', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  const { woo_url, woo_key, woo_secret } = req.body
  if (!woo_url || !woo_key || !woo_secret) {
    return res.status(400).json({ error: 'URL, Consumer Key y Consumer Secret son requeridos' })
  }
  // Don't save placeholder values
  if (woo_key === '***' || woo_secret === '***') {
    return res.status(400).json({ error: 'Ingresa las credenciales reales' })
  }
  try {
    const config = {
      woo_url: woo_url.trim().replace(/\/$/, ''),
      woo_key: woo_key.trim(),
      woo_secret: woo_secret.trim(),
    }
    // Test connection before saving
    await testWooConnection(config)
    // Save to DB
    const db = getDb()
    const exists = db.prepare("SELECT id FROM settings WHERE key = 'woocommerce_config'").get()
    if (exists) {
      db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'woocommerce_config'")
        .run(JSON.stringify(config))
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('woocommerce_config', ?)")
        .run(JSON.stringify(config))
    }
    res.json({ success: true, message: 'Conexión exitosa. Configuración guardada.' })
  } catch (err) {
    res.status(400).json({ error: `No se pudo conectar: ${err.message}` })
  }
})

// POST /api/wordpress/sync-categories - importa categorías desde WooCommerce
router.post('/sync-categories', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })

    const base = config.woo_url
    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    const headers = { Authorization: `Basic ${auth}` }

    let page = 1, total = 0
    while (true) {
      const r = await fetch(`${base}/wp-json/wc/v3/products/categories?per_page=100&page=${page}`, { headers })
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const cats = await r.json()
      if (!cats.length) break
      for (const cat of cats) {
        const exists = db.prepare('SELECT id FROM categories WHERE woo_id = ?').get(cat.id)
        const slug = cat.slug || cat.name.toLowerCase().replace(/\s+/g, '-')
        if (exists) {
          db.prepare('UPDATE categories SET name=?, slug=?, parent_id=?, updated_at=CURRENT_TIMESTAMP WHERE woo_id=?')
            .run(cat.name, slug, cat.parent || null, cat.id)
        } else {
          db.prepare('INSERT INTO categories (name, slug, woo_id, parent_id) VALUES (?,?,?,?)')
            .run(cat.name, slug, cat.id, cat.parent || null)
        }
        total++
      }
      if (cats.length < 100) break
      page++
    }
    res.json({ success: true, message: `${total} categorías sincronizadas` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/sync-products - importa productos desde WooCommerce
router.post('/sync-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })

    const base = config.woo_url
    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    const headers = { Authorization: `Basic ${auth}` }

    let page = 1, total = 0
    while (true) {
      const r = await fetch(`${base}/wp-json/wc/v3/products?per_page=50&page=${page}&status=publish`, { headers })
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const products = await r.json()
      if (!products.length) break
      for (const p of products) {
        const exists = db.prepare('SELECT id FROM products WHERE woo_id = ?').get(p.id)
        const data = [
          p.name, p.slug || '', p.sku || '', p.description || '',
          p.short_description || '', p.price || '0', p.sale_price || null,
          p.stock_quantity || 0, p.stock_status || 'instock',
          p.weight || null, 'publish', p.id
        ]
        if (exists) {
          db.prepare(`UPDATE products SET name=?,slug=?,sku=?,description=?,short_description=?,
            price=?,sale_price=?,stock_quantity=?,stock_status=?,weight=?,status=?,updated_at=CURRENT_TIMESTAMP
            WHERE woo_id=?`).run(...data)
        } else {
          db.prepare(`INSERT INTO products (name,slug,sku,description,short_description,
            price,sale_price,stock_quantity,stock_status,weight,status,woo_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...data)
        }
        total++
      }
      if (products.length < 50) break
      page++
    }
    res.json({ success: true, message: `${total} productos sincronizados desde WooCommerce` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/publish-products - publica productos locales a WooCommerce
router.post('/publish-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })

    const products = db.prepare("SELECT * FROM products WHERE (woo_id IS NULL OR woo_id = '') AND status = 'publish' LIMIT 50").all()
    if (!products.length) return res.json({ success: true, message: 'No hay productos nuevos para publicar' })

    const base = config.woo_url
    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }

    let published = 0, errors = 0
    for (const p of products) {
      try {
        const body = {
          name: p.name, sku: p.sku || undefined,
          description: p.description || '', short_description: p.short_description || '',
          regular_price: String(p.price || '0'),
          sale_price: p.sale_price ? String(p.sale_price) : undefined,
          stock_quantity: p.stock_quantity || 0,
          manage_stock: true, status: 'publish',
        }
        const r = await fetch(`${base}/wp-json/wc/v3/products`, {
          method: 'POST', headers, body: JSON.stringify(body)
        })
        if (r.ok) {
          const woo = await r.json()
          db.prepare('UPDATE products SET woo_id=? WHERE id=?').run(woo.id, p.id)
          published++
        } else { errors++ }
      } catch { errors++ }
    }
    res.json({ success: true, message: `${published} publicados${errors ? `, ${errors} errores` : ''}` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
