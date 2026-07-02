const express = require('express');
const bcrypt = require('bcryptjs');
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

    CREATE TABLE IF NOT EXISTS technician_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      company TEXT,
      assigned_vendor_id INTEGER,
      assigned_vendor_name TEXT,
      active INTEGER DEFAULT 1,
      can_order INTEGER DEFAULT 1,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS technician_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE,
      technician_user_id INTEGER,
      technician_profile_id INTEGER,
      technician_name TEXT,
      technician_phone TEXT,
      seller_user_id INTEGER,
      seller_name TEXT,
      branch_pickup TEXT DEFAULT 'PRINCIPAL',
      status TEXT DEFAULT 'pending',
      subtotal REAL DEFAULT 0,
      notes TEXT,
      status_notes TEXT,
      confirmed_by INTEGER,
      confirmed_at DATETIME,
      delivered_at DATETIME,
      canceled_at DATETIME,
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

  addColumnIfMissing(db, 'technician_orders', 'technician_profile_id', 'INTEGER');
  addColumnIfMissing(db, 'technician_orders', 'seller_user_id', 'INTEGER');
  addColumnIfMissing(db, 'technician_orders', 'seller_name', 'TEXT');
  addColumnIfMissing(db, 'technician_orders', 'status_notes', 'TEXT');
  addColumnIfMissing(db, 'technician_orders', 'confirmed_by', 'INTEGER');
  addColumnIfMissing(db, 'technician_orders', 'confirmed_at', 'DATETIME');
  addColumnIfMissing(db, 'technician_orders', 'delivered_at', 'DATETIME');
  addColumnIfMissing(db, 'technician_orders', 'canceled_at', 'DATETIME');
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSku(value) {
  return String(value || '').trim().toLowerCase();
}

function roleOf(user) {
  return String(user?.role || '').toLowerCase();
}

function canManageGovernance(user) {
  return ['superadmin', 'admin'].includes(roleOf(user));
}

function canReadProducts(user) {
  return ['superadmin', 'admin', 'contabilidad', 'accounting', 'vendedor', 'marketing'].includes(roleOf(user));
}

function isTechnician(user) {
  return ['tecnico', 'técnico', 'technician'].includes(roleOf(user));
}

function canManageTechnicians(user) {
  return ['superadmin', 'admin', 'vendedor'].includes(roleOf(user));
}

function canManageAllTechnicians(user) {
  return ['superadmin', 'admin'].includes(roleOf(user));
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

function getUserById(db, id) {
  if (!id) return null;
  try {
    return db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ?').get(Number(id));
  } catch (error) {
    return null;
  }
}

function getVendorName(db, id) {
  const user = getUserById(db, id);
  return user?.name || user?.email || '';
}

function getMyTechnicianProfile(db, user) {
  if (!user?.id) return null;
  try {
    return db.prepare(`
      SELECT tp.*, u.name AS user_name, u.email AS user_email, u.active AS user_active
      FROM technician_profiles tp
      LEFT JOIN users u ON u.id = tp.user_id
      WHERE tp.user_id = ?
      ORDER BY tp.id DESC
      LIMIT 1
    `).get(user.id) || null;
  } catch (error) {
    return null;
  }
}

function buildOrderWhereForUser(user) {
  const role = roleOf(user);
  if (['superadmin', 'admin'].includes(role)) return { where: '', params: [] };
  if (role === 'vendedor') return { where: 'WHERE seller_user_id = ?', params: [user.id || 0] };
  if (isTechnician(user)) return { where: 'WHERE technician_user_id = ?', params: [user.id || 0] };
  return { where: 'WHERE 1=0', params: [] };
}

function getOrderWithItems(db, orderId) {
  const order = db.prepare('SELECT * FROM technician_orders WHERE id = ?').get(orderId);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM technician_order_items WHERE order_id = ? ORDER BY id ASC').all(orderId);
  return order;
}

// Ruta pública de diagnóstico para validar dominio/proxy sin token.
router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    module: 'product-governance',
    version: 'v54',
    message: 'Ruta product-governance activa',
    timestamp: new Date().toISOString(),
  });
});

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

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    return res.json({ success: true, product });
  } catch (error) {
    console.error('product-governance update error:', error);
    return res.status(500).json({ error: error.message || 'Error actualizando gobernanza' });
  }
});

router.get('/technician/vendors', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);
    const role = roleOf(req.user);
    let vendors;
    if (role === 'vendedor') {
      vendors = db.prepare(`SELECT id, name, email, role FROM users WHERE id = ? AND active = 1`).all(req.user.id || 0);
    } else {
      vendors = db.prepare(`
        SELECT id, name, email, role
        FROM users
        WHERE active = 1 AND role IN ('vendedor','admin','superadmin')
        ORDER BY CASE role WHEN 'vendedor' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, name ASC
      `).all();
    }
    return res.json({ vendors });
  } catch (error) {
    console.error('technician vendors error:', error);
    return res.status(500).json({ error: error.message || 'Error listando vendedores' });
  }
});

router.get('/technician/me', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);
    const profile = getMyTechnicianProfile(db, req.user);
    return res.json({ user: req.user, profile });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error obteniendo perfil técnico' });
  }
});

router.get('/technician/profiles', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);
    const role = roleOf(req.user);
    let where = '';
    const params = [];
    if (role === 'vendedor') {
      where = 'WHERE tp.assigned_vendor_id = ? OR tp.created_by = ?';
      params.push(req.user.id || 0, req.user.id || 0);
    } else if (isTechnician(req.user)) {
      where = 'WHERE tp.user_id = ?';
      params.push(req.user.id || 0);
    } else if (!['superadmin', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Sin permisos para ver técnicos' });
    }

    const profiles = db.prepare(`
      SELECT tp.*, u.name AS user_name, u.email AS user_email, u.active AS user_active, v.name AS vendor_user_name, v.email AS vendor_email
      FROM technician_profiles tp
      LEFT JOIN users u ON u.id = tp.user_id
      LEFT JOIN users v ON v.id = tp.assigned_vendor_id
      ${where}
      ORDER BY tp.created_at DESC, tp.id DESC
      LIMIT 500
    `).all(params);

    return res.json({ profiles });
  } catch (error) {
    console.error('technician profiles list error:', error);
    return res.status(500).json({ error: error.message || 'Error listando perfiles técnicos' });
  }
});

router.post('/technician/profiles', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);
    if (!canManageTechnicians(req.user)) return res.status(403).json({ error: 'Sin permisos para crear técnicos' });

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '').trim();
    if (!name) return res.status(400).json({ error: 'El nombre del técnico es requerido' });
    if (!email) return res.status(400).json({ error: 'El correo del técnico es requerido para que pueda iniciar sesión' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    let assignedVendorId = Number(req.body.assigned_vendor_id || 0) || null;
    if (roleOf(req.user) === 'vendedor') assignedVendorId = req.user.id;
    if (!assignedVendorId) return res.status(400).json({ error: 'Selecciona el vendedor responsable del técnico' });
    const vendor = getUserById(db, assignedVendorId);
    if (!vendor || !['vendedor', 'admin', 'superadmin'].includes(String(vendor.role || '').toLowerCase())) {
      return res.status(400).json({ error: 'Vendedor responsable no válido' });
    }

    let user = db.prepare('SELECT id, email, name, role FROM users WHERE email = ?').get(email);
    if (user && !isTechnician(user)) {
      return res.status(400).json({ error: 'Ese correo ya pertenece a un usuario que no es técnico' });
    }

    if (!user) {
      const result = db.prepare('INSERT INTO users(name,email,password,role,active) VALUES(?,?,?,?,?)')
        .run(name, email, bcrypt.hashSync(password, 10), 'tecnico', Number(req.body.active ?? 1));
      const userId = result?.lastInsertRowid || result?.lastID || db.prepare('SELECT last_insert_rowid() AS id').get().id;
      user = { id: userId, email, name, role: 'tecnico' };
    } else {
      db.prepare('UPDATE users SET name = ?, password = ?, role = ?, active = ? WHERE id = ?')
        .run(name, bcrypt.hashSync(password, 10), 'tecnico', Number(req.body.active ?? 1), user.id);
    }

    const existingProfile = db.prepare('SELECT id FROM technician_profiles WHERE user_id = ?').get(user.id);
    const assignedVendorName = vendor.name || vendor.email || '';
    let profileId;
    if (existingProfile) {
      db.prepare(`
        UPDATE technician_profiles
        SET name = ?, phone = ?, email = ?, company = ?, assigned_vendor_id = ?, assigned_vendor_name = ?, active = ?, can_order = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run([
        name,
        phone,
        email,
        req.body.company || '',
        assignedVendorId,
        assignedVendorName,
        Number(req.body.active ?? 1),
        Number(req.body.can_order ?? 1),
        req.body.notes || '',
        existingProfile.id,
      ]);
      profileId = existingProfile.id;
    } else {
      const result = db.prepare(`
        INSERT INTO technician_profiles(user_id,name,phone,email,company,assigned_vendor_id,assigned_vendor_name,active,can_order,notes,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `).run([
        user.id,
        name,
        phone,
        email,
        req.body.company || '',
        assignedVendorId,
        assignedVendorName,
        Number(req.body.active ?? 1),
        Number(req.body.can_order ?? 1),
        req.body.notes || '',
        req.user.id || null,
      ]);
      profileId = result?.lastInsertRowid || result?.lastID || db.prepare('SELECT last_insert_rowid() AS id').get().id;
    }

    const profile = db.prepare('SELECT * FROM technician_profiles WHERE id = ?').get(profileId);
    return res.status(201).json({ success: true, profile, user: { id: user.id, name, email, role: 'tecnico' } });
  } catch (error) {
    console.error('technician profile create error:', error);
    return res.status(500).json({ error: error.message || 'Error creando perfil técnico' });
  }
});

router.patch('/technician/profiles/:id', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);
    if (!canManageTechnicians(req.user)) return res.status(403).json({ error: 'Sin permisos para actualizar técnicos' });

    const id = Number(req.params.id);
    const profile = db.prepare('SELECT * FROM technician_profiles WHERE id = ?').get(id);
    if (!profile) return res.status(404).json({ error: 'Perfil técnico no encontrado' });
    if (roleOf(req.user) === 'vendedor' && Number(profile.assigned_vendor_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Solo puedes editar técnicos asignados a tu usuario' });
    }

    let assignedVendorId = Number(req.body.assigned_vendor_id || profile.assigned_vendor_id || 0) || null;
    if (roleOf(req.user) === 'vendedor') assignedVendorId = req.user.id;
    const vendor = getUserById(db, assignedVendorId);
    const assignedVendorName = vendor?.name || vendor?.email || profile.assigned_vendor_name || '';

    const name = req.body.name ?? profile.name;
    const phone = req.body.phone ?? profile.phone;
    const email = req.body.email ?? profile.email;
    const active = Number(req.body.active ?? profile.active);
    const canOrder = Number(req.body.can_order ?? profile.can_order);

    db.prepare(`
      UPDATE technician_profiles
      SET name = ?, phone = ?, email = ?, company = ?, assigned_vendor_id = ?, assigned_vendor_name = ?, active = ?, can_order = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run([
      name,
      phone,
      email,
      req.body.company ?? profile.company,
      assignedVendorId,
      assignedVendorName,
      active,
      canOrder,
      req.body.notes ?? profile.notes,
      id,
    ]);

    if (profile.user_id) {
      const updates = ['name = ?', 'email = ?', 'active = ?'];
      const values = [name, email, active];
      if (req.body.password && String(req.body.password).length >= 8) {
        updates.push('password = ?');
        values.push(bcrypt.hashSync(String(req.body.password), 10));
      }
      values.push(profile.user_id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(values);
    }

    const updated = db.prepare('SELECT * FROM technician_profiles WHERE id = ?').get(id);
    return res.json({ success: true, profile: updated });
  } catch (error) {
    console.error('technician profile update error:', error);
    return res.status(500).json({ error: error.message || 'Error actualizando perfil técnico' });
  }
});

router.get('/technician/catalog', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    const role = roleOf(req.user);
    const canSeeCatalog = ['superadmin', 'admin', 'vendedor', 'tecnico', 'técnico', 'technician'].includes(role);
    if (!canSeeCatalog) return res.status(403).json({ error: 'Sin permisos para catálogo técnico' });

    if (isTechnician(req.user)) {
      const profile = getMyTechnicianProfile(db, req.user);
      if (!profile || Number(profile.active) !== 1) {
        return res.status(403).json({ error: 'Perfil técnico no activo. Contacta a tu vendedor o administrador.' });
      }
    }

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

    const role = roleOf(req.user);
    const canCreate = ['superadmin', 'admin', 'vendedor', 'tecnico', 'técnico', 'technician'].includes(role);
    if (!canCreate) return res.status(403).json({ error: 'Sin permisos para crear pedido técnico' });

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'El pedido debe tener productos' });

    let profile = null;
    let technicianProfileId = Number(req.body.technician_profile_id || 0) || null;
    if (technicianProfileId) {
      profile = db.prepare('SELECT * FROM technician_profiles WHERE id = ?').get(technicianProfileId);
    }
    if (isTechnician(req.user)) {
      profile = getMyTechnicianProfile(db, req.user);
      if (!profile || Number(profile.active) !== 1 || Number(profile.can_order) !== 1) {
        return res.status(403).json({ error: 'Tu perfil técnico no está activo para pedidos' });
      }
      technicianProfileId = profile.id;
    }

    let sellerUserId = Number(req.body.seller_user_id || 0) || null;
    if (role === 'vendedor') sellerUserId = req.user.id;
    if (!sellerUserId && profile?.assigned_vendor_id) sellerUserId = Number(profile.assigned_vendor_id);
    if (!sellerUserId) return res.status(400).json({ error: 'Selecciona el vendedor responsable del pedido' });

    const seller = getUserById(db, sellerUserId);
    if (!seller || !['vendedor', 'admin', 'superadmin'].includes(String(seller.role || '').toLowerCase())) {
      return res.status(400).json({ error: 'Vendedor responsable no válido' });
    }

    const orderNumber = `TEC-${Date.now()}`;
    const branch = req.body.branch_pickup || 'PRINCIPAL';
    const technicianName = profile?.name || req.body.technician_name || req.user.name || req.user.email || 'Técnico';
    const technicianPhone = profile?.phone || req.body.technician_phone || '';
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
        technician_profile_id,
        technician_name,
        technician_phone,
        seller_user_id,
        seller_name,
        branch_pickup,
        status,
        subtotal,
        notes,
        created_at,
        updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).run([
      orderNumber,
      req.user.id || null,
      technicianProfileId,
      technicianName,
      technicianPhone,
      sellerUserId,
      seller.name || seller.email || '',
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

    return res.status(201).json({ success: true, order_id: orderId, order_number: orderNumber, subtotal, seller_user_id: sellerUserId });
  } catch (error) {
    console.error('technician order error:', error);
    return res.status(500).json({ error: error.message || 'Error creando pedido técnico' });
  }
});

router.get('/technician/orders', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    const { where, params } = buildOrderWhereForUser(req.user);
    const orders = db.prepare(`
      SELECT *
      FROM technician_orders
      ${where}
      ORDER BY created_at DESC
      LIMIT 200
    `).all(params);

    const withItems = orders.map((order) => ({
      ...order,
      items: db.prepare('SELECT * FROM technician_order_items WHERE order_id = ? ORDER BY id ASC').all(order.id),
    }));

    return res.json({ orders: withItems });
  } catch (error) {
    console.error('technician orders list error:', error);
    return res.status(500).json({ error: error.message || 'Error listando pedidos técnicos' });
  }
});

router.patch('/technician/orders/:id/status', (req, res) => {
  try {
    const db = getDb();
    ensureGovernanceSchema(db);

    const role = roleOf(req.user);
    if (!['superadmin', 'admin', 'vendedor'].includes(role)) {
      return res.status(403).json({ error: 'Sin permisos para actualizar pedidos técnicos' });
    }

    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM technician_orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Pedido técnico no encontrado' });
    if (role === 'vendedor' && Number(order.seller_user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Solo puedes actualizar pedidos asignados a tu vendedor' });
    }

    const status = String(req.body.status || '').trim().toLowerCase();
    const allowed = ['pending', 'confirmed', 'paid', 'ready', 'delivered', 'cancelled', 'canceled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Estado no válido' });
    const normalizedStatus = status === 'canceled' ? 'cancelled' : status;

    const updates = ['status = ?', 'status_notes = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [normalizedStatus, req.body.status_notes || ''];
    if (['confirmed', 'paid', 'ready'].includes(normalizedStatus)) {
      updates.push('confirmed_by = ?', 'confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP)');
      values.push(req.user.id || null);
    }
    if (normalizedStatus === 'delivered') updates.push('delivered_at = CURRENT_TIMESTAMP');
    if (normalizedStatus === 'cancelled') updates.push('canceled_at = CURRENT_TIMESTAMP');
    values.push(id);

    db.prepare(`UPDATE technician_orders SET ${updates.join(', ')} WHERE id = ?`).run(values);
    const updated = getOrderWithItems(db, id);
    return res.json({ success: true, order: updated });
  } catch (error) {
    console.error('technician order status error:', error);
    return res.status(500).json({ error: error.message || 'Error actualizando pedido técnico' });
  }
});

module.exports = router;
