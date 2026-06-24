const express = require('express')
const router = express.Router()
const https = require('https')
const http = require('http')
const { authMiddleware, requireRole } = require('../middleware/auth')
const { getDb } = require('../database')

// Ensure settings table exists
function ensureSettingsTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run()
}

function getWooConfig(db) {
  ensureSettingsTable(db)
  const row = db.prepare("SELECT value FROM settings WHERE key = 'woocommerce_config'").get()
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return null }
}

// Simple HTTP request helper (compatible with any Node version)
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const lib = parsedUrl.protocol === 'https:' ? https : http
    const req = lib.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)) } catch { resolve(data) }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

// GET /api/wordpress/status
router.get('/status', authMiddleware, (req, res) => {
  try {
    const db = getDb()
    ensureSettingsTable(db)
    const config = getWooConfig(db)
    if (!config) return res.json({ connected: false, woo_url: null })
    res.json({ connected: true, woo_url: config.woo_url, has_key: !!config.woo_key })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/config - guarda y prueba la conexión
router.post('/config', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { woo_url, woo_key, woo_secret } = req.body || {}
    if (!woo_url || !woo_key || !woo_secret) {
      return res.status(400).json({ error: 'URL, Consumer Key y Consumer Secret son requeridos' })
    }
    if (woo_key === '***' || woo_secret === '***') {
      return res.status(400).json({ error: 'Ingresa las credenciales reales (no los asteriscos)' })
    }

    const baseUrl = woo_url.trim().replace(/\/$/, '')
    const credentials = Buffer.from(`${woo_key.trim()}:${woo_secret.trim()}`).toString('base64')

    // Test connection
    try {
      await httpRequest(`${baseUrl}/wp-json/wc/v3/products?per_page=1`, {
        headers: { 'Authorization': `Basic ${credentials}` }
      })
    } catch (connErr) {
      return res.status(400).json({
        error: `No se pudo conectar a WooCommerce: ${connErr.message}. Verifica la URL y las credenciales.`
      })
    }

    const config = { woo_url: baseUrl, woo_key: woo_key.trim(), woo_secret: woo_secret.trim() }
    const db = getDb()
    ensureSettingsTable(db)
    const exists = db.prepare("SELECT id FROM settings WHERE key = 'woocommerce_config'").get()
    if (exists) {
      db.prepare("UPDATE settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='woocommerce_config'")
        .run(JSON.stringify(config))
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('woocommerce_config', ?)").run(JSON.stringify(config))
    }
    res.json({ success: true, message: 'Conexión exitosa. Configuración guardada.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/sync-categories
router.post('/sync-categories', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })
    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    let page = 1, total = 0
    while (true) {
      const cats = await httpRequest(
        `${config.woo_url}/wp-json/wc/v3/products/categories?per_page=100&page=${page}`,
        { headers: { 'Authorization': `Basic ${auth}` } }
      )
      if (!Array.isArray(cats) || !cats.length) break
      for (const cat of cats) {
        const slug = cat.slug || cat.name.toLowerCase().replace(/\s+/g, '-')
        const exists = db.prepare('SELECT id FROM categories WHERE woo_id=?').get(cat.id)
        if (exists) {
          db.prepare('UPDATE categories SET name=?,slug=?,updated_at=CURRENT_TIMESTAMP WHERE woo_id=?').run(cat.name, slug, cat.id)
        } else {
          db.prepare('INSERT INTO categories (name,slug,woo_id) VALUES (?,?,?)').run(cat.name, slug, cat.id)
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

// POST /api/wordpress/sync-products
router.post('/sync-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })
    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    let page = 1, total = 0
    while (true) {
      const products = await httpRequest(
        `${config.woo_url}/wp-json/wc/v3/products?per_page=50&page=${page}&status=publish`,
        { headers: { 'Authorization': `Basic ${auth}` } }
      )
      if (!Array.isArray(products) || !products.length) break
      for (const p of products) {
        const exists = db.prepare('SELECT id FROM products WHERE woo_id=?').get(p.id)
        const mainImg = p.images && p.images[0] ? p.images[0].src : null
        if (exists) {
          db.prepare(`UPDATE products SET name=?,sku=?,description=?,short_description=?,
            price=?,sale_price=?,stock_quantity=?,stock_status=?,status=?,main_image=?,
            updated_at=CURRENT_TIMESTAMP WHERE woo_id=?`)
            .run(p.name, p.sku||'', p.description||'', p.short_description||'',
              p.price||'0', p.sale_price||null, p.stock_quantity||0,
              p.stock_status||'instock', 'publish', mainImg, p.id)
        } else {
          db.prepare(`INSERT INTO products (name,sku,description,short_description,
            price,sale_price,stock_quantity,stock_status,status,main_image,woo_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(p.name, p.sku||'', p.description||'', p.short_description||'',
              p.price||'0', p.sale_price||null, p.stock_quantity||0,
              p.stock_status||'instock', 'publish', mainImg, p.id)
        }
        total++
      }
      if (products.length < 50) break
      page++
    }
    res.json({ success: true, message: `${total} productos sincronizados` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/publish-products
router.post('/publish-products', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })
    const products = db.prepare("SELECT * FROM products WHERE (woo_id IS NULL OR woo_id='') AND status='publish' LIMIT 50").all()
    if (!products.length) return res.json({ success: true, message: 'No hay productos nuevos para publicar' })
    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    let published = 0, errors = 0
    for (const p of products) {
      try {
        const body = JSON.stringify({
          name: p.name, sku: p.sku||undefined,
          description: p.description||'', short_description: p.short_description||'',
          regular_price: String(p.price||'0'),
          sale_price: p.sale_price ? String(p.sale_price) : undefined,
          stock_quantity: p.stock_quantity||0, manage_stock: true, status: 'publish',
        })
        const woo = await httpRequest(`${config.woo_url}/wp-json/wc/v3/products`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          body
        })
        if (woo.id) { db.prepare('UPDATE products SET woo_id=? WHERE id=?').run(woo.id, p.id); published++ }
        else errors++
      } catch { errors++ }
    }
    res.json({ success: true, message: `${published} publicados${errors ? `, ${errors} con error` : ''}` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router

// GET /api/wordpress/compare — compara WooCommerce vs local
router.get('/compare', authMiddleware, async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })

    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    const headers = { 'Authorization': `Basic ${auth}` }

    // Fetch all WooCommerce products
    let wooProd = [], page = 1
    while (true) {
      const data = await httpRequest(
        `${config.woo_url}/wp-json/wc/v3/products?per_page=100&page=${page}&status=any`,
        { headers }
      )
      if (!Array.isArray(data) || !data.length) break
      wooProd = wooProd.concat(data)
      if (data.length < 100) break
      page++
    }

    // Fetch all local products
    const localProd = db.prepare('SELECT * FROM products').all()

    // Build sets
    const wooById = {}
    for (const p of wooProd) wooById[p.id] = p

    const localByWooId = {}
    const localBySku = {}
    for (const p of localProd) {
      if (p.woo_id) localByWooId[p.woo_id] = p
      if (p.sku) localBySku[p.sku] = p
    }

    const woo_only = []
    const both = []
    const matchedLocalIds = new Set()

    for (const wp of wooProd) {
      const localMatch = localByWooId[wp.id] || (wp.sku ? localBySku[wp.sku] : null)
      const mainImg = wp.images && wp.images[0] ? wp.images[0].src : null
      const catNames = wp.categories ? wp.categories.map(c => c.name).join(', ') : ''

      if (localMatch) {
        both.push({
          id: localMatch.id,
          woo_id: wp.id,
          name: wp.name,
          sku: wp.sku || localMatch.sku,
          price: wp.price || localMatch.price,
          sale_price: wp.sale_price || localMatch.sale_price,
          stock_status: wp.stock_status || localMatch.stock_status,
          main_image: mainImg || localMatch.main_image,
          categories_names: catNames,
        })
        matchedLocalIds.add(localMatch.id)
      } else {
        woo_only.push({
          woo_id: wp.id,
          name: wp.name,
          sku: wp.sku || '',
          description: wp.description || '',
          short_description: wp.short_description || '',
          price: wp.price || '0',
          sale_price: wp.sale_price || null,
          stock_quantity: wp.stock_quantity || 0,
          stock_status: wp.stock_status || 'instock',
          main_image: mainImg,
          categories_names: catNames,
          categories: wp.categories || [],
          images: wp.images || [],
          weight: wp.weight || null,
          attributes: wp.attributes || [],
        })
      }
    }

    const local_only = localProd.filter(p => !matchedLocalIds.has(p.id)).map(p => ({
      id: p.id, name: p.name, sku: p.sku, price: p.price,
      sale_price: p.sale_price, stock_status: p.stock_status, main_image: p.main_image,
    }))

    res.json({
      woo_only,
      local_only,
      both,
      summary: { woo_total: wooProd.length, local_total: localProd.length, synced: both.length }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/import-selected — importa WooCommerce → local
router.post('/import-selected', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })

    const { woo_ids = [] } = req.body
    if (!woo_ids.length) return res.status(400).json({ error: 'No se seleccionaron productos' })

    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    let imported = 0, errors = 0

    for (const woo_id of woo_ids) {
      try {
        const wp = await httpRequest(
          `${config.woo_url}/wp-json/wc/v3/products/${woo_id}`,
          { headers: { Authorization: `Basic ${auth}` } }
        )
        const mainImg = wp.images && wp.images[0] ? wp.images[0].src : null
        const catNames = wp.categories ? wp.categories.map(c => c.name).join(', ') : ''

        const exists = db.prepare('SELECT id FROM products WHERE woo_id=?').get(woo_id)
        if (exists) {
          db.prepare(`UPDATE products SET name=?,sku=?,description=?,short_description=?,
            price=?,sale_price=?,stock_quantity=?,stock_status=?,weight=?,main_image=?,
            status='publish',updated_at=CURRENT_TIMESTAMP WHERE woo_id=?`)
            .run(wp.name, wp.sku||'', wp.description||'', wp.short_description||'',
              wp.price||'0', wp.sale_price||null, wp.stock_quantity||0,
              wp.stock_status||'instock', wp.weight||null, mainImg, woo_id)
        } else {
          db.prepare(`INSERT INTO products (name,sku,description,short_description,
            price,sale_price,stock_quantity,stock_status,weight,main_image,status,woo_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(wp.name, wp.sku||'', wp.description||'', wp.short_description||'',
              wp.price||'0', wp.sale_price||null, wp.stock_quantity||0,
              wp.stock_status||'instock', wp.weight||null, mainImg, 'publish', woo_id)
        }
        imported++
      } catch { errors++ }
    }

    res.json({
      success: true,
      message: `${imported} productos importados${errors ? `, ${errors} errores` : ''}`
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/wordpress/push-selected — publica productos locales → WooCommerce
router.post('/push-selected', authMiddleware, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const db = getDb()
    const config = getWooConfig(db)
    if (!config) return res.status(400).json({ error: 'WooCommerce no configurado' })

    const { local_ids = [] } = req.body
    if (!local_ids.length) return res.status(400).json({ error: 'No se seleccionaron productos' })

    const auth = Buffer.from(`${config.woo_key}:${config.woo_secret}`).toString('base64')
    let pushed = 0, errors = 0

    for (const id of local_ids) {
      const p = db.prepare('SELECT * FROM products WHERE id=?').get(id)
      if (!p) { errors++; continue }
      try {
        const body = JSON.stringify({
          name: p.name, sku: p.sku || undefined,
          description: p.description || '', short_description: p.short_description || '',
          regular_price: String(p.price || '0'),
          sale_price: p.sale_price ? String(p.sale_price) : undefined,
          stock_quantity: p.stock_quantity || 0, manage_stock: true, status: 'publish',
        })
        const woo = await httpRequest(`${config.woo_url}/wp-json/wc/v3/products`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`, 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          body
        })
        if (woo.id) {
          db.prepare('UPDATE products SET woo_id=? WHERE id=?').run(woo.id, id)
          pushed++
        } else errors++
      } catch { errors++ }
    }

    res.json({ success: true, message: `${pushed} publicados en WooCommerce${errors ? `, ${errors} errores` : ''}` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
