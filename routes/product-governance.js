const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

function getColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name);
  } catch (error) {
    return [];
  }
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = getColumns(db, table);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureGovernanceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_import_batches (
      id TEXT PRIMARY KEY,
      source_system TEXT DEFAULT 'symasoft',
      filename TEXT,
      total_rows INTEGER DEFAULT 0,
      imported_count INTEGER DEFAULT 0,
      duplicated_sku_count INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS technician_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE,
      technician_user_id INTEGER,
      technician_name TEXT,
      technician_phone TEXT,
      branch_pickup TEXT DEFAULT 'PRINCIPAL',
      status TEXT DEFAULT 'pending',
      subtotal REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS technician_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER DEFAULT 1,
      technician_price REAL DEFAULT 0,
      subtotal REAL DEFAULT 0
    );
  `);

  addColumnIfMissing(db, 'products', 'source_system', "TEXT DEFAULT 'manual'");
  addColumnIfMissing(db, 'products', 'external_source_id', 'TEXT');
  addColumnIfMissing(db, 'products', 'import_batch_id', 'TEXT');
  addColumnIfMissing(db, 'products', 'data_quality_status', "TEXT DEFAULT 'new'");
  addColumnIfMissing(db, 'products', 'commercial_status', "TEXT DEFAULT 'available'");
  addColumnIfMissing(db, 'products', 'web_work_status', "TEXT DEFAULT 'pending'");
  addColumnIfMissing(db, 'products', 'category_confidence', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'ai_category_suggestion', 'TEXT');
  addColumnIfMissing(db, 'products', 'category_review_required', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'products', 'is_visible_to_technicians', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'products', 'technician_can_order', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'products', 'technician_price', 'REAL DEFAULT 0');
  addColumnIfMissing(db, 'products', 'expected_arrival_date', 'TEXT');
  addColumnIfMissing(db, 'products', 'expected_quantity', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'products', 'reserved_quantity', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'products', 'branch_pickup', "TEXT DEFAULT 'PRINCIPAL'");
  addColumnIfMissing(db, 'products', 'last_imported_at', 'DATETIME');
  addColumnIfMissing(db, 'products', 'governance_notes', 'TEXT');
  addColumnIfMissing(db, 'products', 'reviewed_by', 'INTEGER');
  addColumnIfMissing(db, 'products', 'reviewed_at', 'DATETIME');
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSku(value) {
  return String(value || '').trim().toLowerCase();
}

function canManageGovernance(user) {
  const role = String(user?.role || '').toLowerCase();
  return ['superadmin', 'admin'].includes(role);
}

function canReadProducts(user) {
  const role = String(user?.role || '').toLowerCase();
  return ['superadmin', 'admin', 'contabilidad', 'accounting', 'vendedor', 'marketing'].includes(role);
}

function isTechnician(user) {
  const role = String(user?.role || '').toLowerCase();
  return ['tecnico', 'técnico', 'technician'].includes(role);
}

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function isPublished(product) {
  const status = String(product.status || '').toLowerCase();
  return Boolean(product.wp_product_id || product.woo_id || ['published', 'publish', 'publicado'].includes(status));
}

function isBackorderOrPreorder(product) {
  const commercialStatus = String(product.commercial_status || '').toLowerCase();
  const status = String(product.status || '').toLowerCase();
  const stockStatus = String(product.stock_status || '').toLowerCase();
  return (
    ['backorder', 'preventa', 'preorder', 'coming_soon'].includes(commercialStatus) ||
    status.includes('backorder') ||
    status.includes('preventa') ||
    status.includes('pre-venta') ||
    stockStatus.includes('backorder') ||
    stockStatus.includes('preorder')
  );
}

function getIssues(product, skuCounts = {}) {
  const issues = [];
  const sku = normalizeSku(product.sku);
  const duplicatedSku = sku && skuCounts[sku] > 1;
  const imageCount = toNumber(product.image_count, 0);
  const missingImage = !(product.main_image || imageCount > 0 || product.image || product.image_url);
  const missingSeo = !(hasText(product.seo_title) && hasText(product.seo_description) && (hasText(product.seo_keyword) || hasText(product.focus_keyword)));
  const missingCategory = !(product.category_id || hasText(product.category_name) || hasText(product.category));
  const missingDescription = !(hasText(product.short_description) || hasText(product.description));
  const missingPrice = !(toNumber(product.price, 0) > 0 || toNumber(product.regular_price, 0) > 0);

  if (missingImage) issues.push('image');
  if (missingSeo) issues.push('seo');
  if (missingCategory) issues.push('category');
  if (missingDescription) issues.push('description');
  if (missingPrice) issues.push('price');
  if (duplicatedSku) issues.push('duplicate_sku');
  if (missingImage || missingSeo || missingCategory || missingDescription || String(product.web_work_status || '').toLowerCase() === 'needs_work') {
    issues.push('web_work');
  }

  return issues;
}

function buildStats(products, skuCounts) {
  const stats = {
    total: products.length,
    new: 0,
    missing_images: 0,
    missing_seo: 0,
    missing_category: 0,
    missing_description: 0,
    missing_price: 0,
    web_work: 0,
    ready: 0,
    backorder: 0,
    duplicates: 0,
    visible_to_technicians: 0,
  };

  products.forEach((product) => {
    const issues = getIssues(product, skuCounts);
    if (!isPublished(product) || String(product.data_quality_status || '').toLowerCase() === 'new') stats.new += 1;
    if (issues.includes('image')) stats.missing_images += 1;
    if (issues.includes('seo')) stats.missing_seo += 1;
    if (issues.includes('category')) stats.missing_category += 1;
    if (issues.includes('description')) stats.missing_description += 1;
    if (issues.includes('price')) stats.missing_price += 1;
    if (issues.includes('web_work')) stats.web_work += 1;
    if (issues.includes('duplicate_sku')) stats.duplicates += 1;
    if (isBackorderOrPreorder(product)) stats.backorder += 1;
    if (Number(product.is_visible_to_technicians) === 1) stats.visible_to_technicians += 1;
    if (issues.length === 0) stats.ready += 1;
  });

  return stats;
}

function listProducts(db, { limit = 500, page = 1, search = '' } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const term = `%${String(search || '').trim()}%`;

  const where = search
    ? `WHERE p.name LIKE ? OR p.sku LIKE ? OR p.model LIKE ? OR b.name LIKE ? OR c.name LIKE ?`
    : '';
  const params = search ? [term, term, term, term, term, safeLimit, offset] : [safeLimit, offset];

  return db.prepare(`
    SELECT
      p.*,
      b.name AS brand_name,
      c.name AS category_name,
      COUNT(pi.id) AS image_count,
      MAX(CASE WHEN pi.is_main = 1 THEN pi.filename ELSE NULL END) AS main_image
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN product_images pi ON pi.product_id = p.id
    ${where}
    GROUP BY p.id
    ORDER BY COALESCE(p.last_imported_at, p.updated_at, p.created_at) DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(params);
}

function getSkuCounts(products) {
  return products.reduce((acc, product) => {
    const sku = normalizeSku(product.sku);
    if (sku) acc[sku] = (acc[sku] || 0) + 1;
    return acc;
  }, {});
}

router.use(authMiddleware);

router.get('/quality', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    if (!canReadProducts(req.user) && !isTechnician(req.user)) {
      return res.status(403).json({ error: 'Sin permisos para ver productos' });
    }

    const products = listProducts(db, req.query);
    const skuCounts = getSkuCounts(products);
    const enriched = products.map((product) => {
      const issues = getIssues(product, skuCounts);
      return {
        ...product,
        quality_issues: issues,
        is_new_product: !isPublished(product) || String(product.data_quality_status || '').toLowerCase() === 'new',
        is_ready_for_woocommerce: issues.length === 0,
        is_backorder_or_preorder: isBackorderOrPreorder(product),
        requires_admin_review: issues.includes('duplicate_sku') || issues.includes('category') || Number(product.category_review_required) === 1,
      };
    });

    return res.json({
      products: enriched,
      stats: buildStats(products, skuCounts),
      page: Math.max(parseInt(req.query.page, 10) || 1, 1),
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000),
    });
  } catch (error) {
    console.error('product-governance quality error:', error);
    return res.status(500).json({ error: error.message || 'Error obteniendo control de calidad' });
  }
});

router.get('/summary', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);
    const products = listProducts(db, { limit: 1000, page: 1 });
    const skuCounts = getSkuCounts(products);
    return res.json({ stats: buildStats(products, skuCounts) });
  } catch (error) {
    console.error('product-governance summary error:', error);
    return res.status(500).json({ error: error.message || 'Error obteniendo resumen' });
  }
});

router.patch('/products/:id/governance', requireRole('superadmin', 'admin'), (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    if (!canManageGovernance(req.user)) {
      return res.status(403).json({ error: 'Sin permisos para gobernanza de productos' });
    }

    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });

    const allowed = [
      'source_system',
      'external_source_id',
      'import_batch_id',
      'data_quality_status',
      'commercial_status',
      'web_work_status',
      'category_confidence',
      'ai_category_suggestion',
      'category_review_required',
      'is_visible_to_technicians',
      'technician_can_order',
      'technician_price',
      'expected_arrival_date',
      'expected_quantity',
      'reserved_quantity',
      'branch_pickup',
      'last_imported_at',
      'governance_notes',
    ];

    const updates = [];
    const values = [];
    allowed.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    });

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No hay campos de gobernanza para actualizar' });
    }

    updates.push('reviewed_by = ?');
    values.push(req.user.id || null);
    updates.push('reviewed_at = CURRENT_TIMESTAMP');
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(values);

    try {
      db.prepare(`INSERT INTO activity_log(user_id, action, entity, entity_id, details, created_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)`)
        .run(req.user.id || null, 'update_product_governance', 'products', id, JSON.stringify(req.body));
    } catch (error) {}

    const product = listProducts(db, { limit: 1, page: 1, search: '' }).find((item) => Number(item.id) === id) ||
      db.prepare('SELECT * FROM products WHERE id = ?').get(id);

    return res.json({ success: true, product });
  } catch (error) {
    console.error('product-governance update error:', error);
    return res.status(500).json({ error: error.message || 'Error actualizando gobernanza' });
  }
});

router.get('/technician/catalog', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    const role = String(req.user?.role || '').toLowerCase();
    const canSeeCatalog = ['superadmin', 'admin', 'vendedor', 'tecnico', 'técnico', 'technician'].includes(role);
    if (!canSeeCatalog) return res.status(403).json({ error: 'Sin permisos para catálogo técnico' });

    const products = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.short_description,
        p.model,
        p.sku,
        p.stock_quantity,
        p.stock_status,
        p.commercial_status,
        p.technician_price,
        p.technician_can_order,
        p.expected_arrival_date,
        p.branch_pickup,
        b.name AS brand_name,
        c.name AS category_name,
        MAX(CASE WHEN pi.is_main = 1 THEN pi.filename ELSE NULL END) AS main_image,
        COUNT(pi.id) AS image_count
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_images pi ON pi.product_id = p.id
      WHERE p.is_visible_to_technicians = 1
      GROUP BY p.id
      ORDER BY p.name ASC
    `).all();

    return res.json({ products });
  } catch (error) {
    console.error('technician catalog error:', error);
    return res.status(500).json({ error: error.message || 'Error cargando catálogo técnico' });
  }
});

router.post('/technician/orders', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    const role = String(req.user?.role || '').toLowerCase();
    const canCreate = ['superadmin', 'admin', 'vendedor', 'tecnico', 'técnico', 'technician'].includes(role);
    if (!canCreate) return res.status(403).json({ error: 'Sin permisos para crear pedido técnico' });

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'El pedido debe tener productos' });

    const orderNumber = `TEC-${Date.now()}`;
    const branch = req.body.branch_pickup || 'PRINCIPAL';
    const technicianName = req.body.technician_name || req.user.name || req.user.email || 'Técnico';
    let subtotal = 0;

    const normalizedItems = items.map((item) => {
      const product = db.prepare(`
        SELECT id, name, sku, technician_price, technician_can_order, is_visible_to_technicians
        FROM products
        WHERE id = ?
      `).get(Number(item.product_id));

      if (!product) throw new Error(`Producto no encontrado: ${item.product_id}`);
      if (Number(product.is_visible_to_technicians) !== 1) throw new Error(`Producto no visible para técnicos: ${product.name}`);
      if (Number(product.technician_can_order) !== 1) throw new Error(`Producto no habilitado para pedido técnico: ${product.name}`);

      const quantity = Math.max(parseInt(item.quantity, 10) || 1, 1);
      const price = toNumber(product.technician_price, 0);
      const lineSubtotal = Number((quantity * price).toFixed(2));
      subtotal += lineSubtotal;

      return {
        product_id: product.id,
        product_name: product.name,
        sku: product.sku,
        quantity,
        technician_price: price,
        subtotal: lineSubtotal,
      };
    });

    const result = db.prepare(`
      INSERT INTO technician_orders(
        order_number,
        technician_user_id,
        technician_name,
        technician_phone,
        branch_pickup,
        status,
        subtotal,
        notes,
        created_at,
        updated_at
      ) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).run([
      orderNumber,
      req.user.id || null,
      technicianName,
      req.body.technician_phone || '',
      branch,
      'pending',
      subtotal,
      req.body.notes || '',
    ]);

    const orderId = result?.lastInsertRowid || result?.lastID || db.prepare('SELECT last_insert_rowid() AS id').get().id;

    normalizedItems.forEach((item) => {
      db.prepare(`
        INSERT INTO technician_order_items(order_id, product_id, product_name, sku, quantity, technician_price, subtotal)
        VALUES(?,?,?,?,?,?,?)
      `).run([orderId, item.product_id, item.product_name, item.sku, item.quantity, item.technician_price, item.subtotal]);
    });

    return res.status(201).json({ success: true, order_id: orderId, order_number: orderNumber, subtotal });
  } catch (error) {
    console.error('technician order error:', error);
    return res.status(500).json({ error: error.message || 'Error creando pedido técnico' });
  }
});

router.get('/technician/orders', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    const role = String(req.user?.role || '').toLowerCase();
    const isAdmin = ['superadmin', 'admin', 'vendedor'].includes(role);
    const params = [];
    let where = '';

    if (!isAdmin) {
      where = 'WHERE technician_user_id = ?';
      params.push(req.user.id || 0);
    }

    const orders = db.prepare(`
      SELECT *
      FROM technician_orders
      ${where}
      ORDER BY created_at DESC
      LIMIT 200
    `).all(params);

    return res.json({ orders });
  } catch (error) {
    console.error('technician orders list error:', error);
    return res.status(500).json({ error: error.message || 'Error listando pedidos técnicos' });
  }
});

module.exports = router;
