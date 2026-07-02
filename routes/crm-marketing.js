const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function roleOf(user) {
  return String(user?.role || '').toLowerCase();
}
function isAdmin(user) {
  return ['superadmin', 'admin'].includes(roleOf(user));
}
function isSales(user) {
  return ['superadmin', 'admin', 'vendedor', 'marketing'].includes(roleOf(user));
}
function canUseMarketing(user) {
  return ['superadmin', 'admin', 'marketing', 'vendedor'].includes(roleOf(user));
}
function escLike(value) {
  return `%${String(value || '').trim().replace(/[%_]/g, '')}%`;
}
function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function getColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; }
}
function tableExists(db, table) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table); } catch { return false; }
}
function addColumnIfMissing(db, table, column, definition) {
  const cols = getColumns(db, table);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function ensureClientColumns(db) {
  if (!tableExists(db, 'clients')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        phone TEXT,
        email TEXT,
        channel TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  addColumnIfMissing(db, 'clients', 'assigned_user_id', 'INTEGER');
  addColumnIfMissing(db, 'clients', 'assigned_user_name', 'TEXT');
  addColumnIfMissing(db, 'clients', 'lifecycle_stage', "TEXT DEFAULT 'lead'");
  addColumnIfMissing(db, 'clients', 'lead_status', "TEXT DEFAULT 'new'");
  addColumnIfMissing(db, 'clients', 'pipeline_status', "TEXT DEFAULT 'open'");
  addColumnIfMissing(db, 'clients', 'is_frequent_customer', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'clients', 'follow_up_at', 'TEXT');
  addColumnIfMissing(db, 'clients', 'last_contacted_at', 'TEXT');
  addColumnIfMissing(db, 'clients', 'crm_score', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'clients', 'crm_notes', 'TEXT');
}
function ensureSchema(db) {
  ensureClientColumns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#2563eb',
      label_type TEXT DEFAULT 'manual',
      description TEXT,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crm_client_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      assigned_by INTEGER,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS crm_client_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      event_type TEXT,
      old_value TEXT,
      new_value TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crm_playbook_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_type TEXT DEFAULT 'manual',
      label_id INTEGER,
      stage TEXT,
      action_text TEXT,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS meta_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT 'Meta Business',
      provider TEXT DEFAULT 'meta',
      page_id TEXT,
      page_name TEXT,
      instagram_business_account_id TEXT,
      instagram_username TEXT,
      ad_account_id TEXT,
      access_token TEXT,
      token_expires_at TEXT,
      status TEXT DEFAULT 'disconnected',
      connected_by INTEGER,
      connected_at DATETIME,
      disconnected_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS marketing_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      niche TEXT,
      audience TEXT,
      product_focus TEXT,
      goal TEXT,
      posts_json TEXT,
      analysis_text TEXT,
      recommendations_json TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS marketing_calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER,
      days INTEGER DEFAULT 30,
      posts_per_day INTEGER DEFAULT 2,
      product_focus TEXT,
      calendar_json TEXT,
      hooks_json TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS marketing_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      product_name TEXT,
      sku TEXT,
      recommendation_type TEXT,
      score INTEGER DEFAULT 0,
      reason TEXT,
      suggested_action TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  seedLabels(db);
}
function seedLabels(db) {
  const defaults = [
    ['Seguimiento', '#2563eb', 'stage', 'Cliente que requiere próxima acción.'],
    ['Cliente frecuente', '#16a34a', 'behavior', 'Compra o consulta recurrentemente.'],
    ['Cotizando', '#f59e0b', 'stage', 'Solicitó precio o propuesta.'],
    ['Ganado', '#10b981', 'stage', 'Cerró compra o pedido.'],
    ['Perdido', '#ef4444', 'stage', 'No compró o se descartó.'],
    ['Técnico', '#7c3aed', 'type', 'Cliente técnico o instalador.'],
    ['Mayorista', '#0f172a', 'type', 'Cliente con potencial de volumen.'],
    ['Pendiente pago', '#dc2626', 'risk', 'Tiene balance o pago por confirmar.'],
  ];
  const stmt = db.prepare('INSERT OR IGNORE INTO crm_labels (name, color, label_type, description) VALUES (?, ?, ?, ?)');
  defaults.forEach((r) => stmt.run(r));
}
function clientNameExpr(cols) {
  if (cols.includes('name')) return 'name';
  if (cols.includes('full_name')) return 'full_name';
  if (cols.includes('client_name')) return 'client_name';
  if (cols.includes('customer_name')) return 'customer_name';
  return "'Cliente sin nombre'";
}
function clientPhoneExpr(cols) {
  if (cols.includes('phone')) return 'phone';
  if (cols.includes('mobile')) return 'mobile';
  if (cols.includes('whatsapp')) return 'whatsapp';
  return "''";
}
function clientEmailExpr(cols) {
  if (cols.includes('email')) return 'email';
  return "''";
}
function getLabelsForClients(db, ids) {
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT cl.client_id, l.id, l.name, l.color, l.label_type
    FROM crm_client_labels cl
    JOIN crm_labels l ON l.id = cl.label_id
    WHERE cl.client_id IN (${placeholders}) AND l.active = 1
    ORDER BY l.name ASC
  `).all(ids);
  return rows.reduce((acc, row) => {
    acc[row.client_id] = acc[row.client_id] || [];
    acc[row.client_id].push(row);
    return acc;
  }, {});
}
function currentConnection(db) {
  return db.prepare('SELECT id, name, page_id, page_name, instagram_business_account_id, instagram_username, ad_account_id, status, connected_at, token_expires_at FROM meta_connections ORDER BY id DESC LIMIT 1').get() || null;
}
function safeJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}
function getProductsForRecommendations(db) {
  try {
    return db.prepare(`
      SELECT id, name, sku, stock_quantity, price, sale_price, commercial_status, web_work_status, is_visible_to_technicians, technician_price
      FROM products
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 250
    `).all();
  } catch { return []; }
}
function buildLocalRecommendations(products) {
  return products.slice(0, 80).map((p) => {
    let score = 45;
    const reasons = [];
    const stock = toNum(p.stock_quantity, 0);
    if (stock > 0) { score += 20; reasons.push('tiene stock disponible'); }
    if (String(p.web_work_status || '').toLowerCase() === 'ready') { score += 15; reasons.push('está listo para web'); }
    if (toNum(p.sale_price, 0) > 0) { score += 10; reasons.push('ya tiene precio de oferta'); }
    if (String(p.commercial_status || '').toLowerCase() === 'backorder' || String(p.commercial_status || '').toLowerCase() === 'preventa') { score += 8; reasons.push('puede comunicarse como preventa/backorder'); }
    if (Number(p.is_visible_to_technicians) === 1) { score += 7; reasons.push('también puede moverse por técnicos'); }
    const action = score >= 75 ? 'Promocionar esta semana' : score >= 60 ? 'Preparar carrusel/reel educativo' : 'Revisar antes de pautar';
    return {
      product_id: p.id,
      product_name: p.name || 'Producto sin nombre',
      sku: p.sku || '',
      recommendation_type: score >= 75 ? 'promocion' : 'contenido',
      score: Math.min(score, 100),
      reason: reasons.length ? reasons.join(', ') : 'producto reciente para revisar',
      suggested_action: action,
    };
  }).sort((a, b) => b.score - a.score).slice(0, 20);
}
function analyzePostsLocally({ niche, audience, product_focus, posts }) {
  const cleanPosts = Array.isArray(posts) ? posts : [];
  const sorted = [...cleanPosts].sort((a, b) => (toNum(b.engagement) + toNum(b.reach) / 100) - (toNum(a.engagement) + toNum(a.reach) / 100));
  const topFormats = sorted.reduce((acc, p) => {
    const f = String(p.format || p.tipo || 'post').toLowerCase();
    acc[f] = (acc[f] || 0) + 1;
    return acc;
  }, {});
  const winningFormat = Object.entries(topFormats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'reels/carruseles';
  const analysis = [
    `Diagnóstico para ${niche || 'el nicho seleccionado'}: el contenido que mejor puede funcionar debe conectar problemas técnicos reales con productos específicos.`,
    `Audiencia principal: ${audience || 'clientes y técnicos que buscan soluciones confiables'}.`,
    `Formato a duplicar: ${winningFormat}. Si los mejores posts tienen demostración, antes/después, instalación o comparación, conviene repetir ese patrón.`,
    `Producto foco: ${product_focus || 'productos con stock y margen comercial'}. La venta debe entrar como solución, no como catálogo frío.`,
    `Enfoque recomendado: educar con errores comunes, riesgos de comprar mal, comparativas simples y casos reales de instalación.`
  ].join('\n\n');
  const recommendations = [
    'Duplicar formatos con mayor retención y guardados.',
    'Crear contenido por categoría: cámaras, inversores, alarmas, redes y control de acceso.',
    'Unir cada pieza a un producto concreto y una acción: cotizar, pedir por WhatsApp o visitar sucursal.',
    'Usar hooks de dolor técnico y ahorro: seguridad, energía, instalación correcta y garantía.',
    'Medir por producto: alcance, consultas generadas, pedidos y cierre por vendedor.'
  ];
  return { analysis, recommendations, top_posts: sorted.slice(0, 5) };
}
function buildCalendar({ days = 30, posts_per_day = 2, product_focus = '', niche = '', audience = '' }) {
  const formats = ['Reel', 'Carrusel', 'Post educativo', 'Reel demostración'];
  const angles = [
    'error común que cuesta dinero',
    'comparación rápida antes de comprar',
    'beneficio técnico explicado simple',
    'caso de uso real para negocio/hogar',
    'checklist antes de instalar',
    'promoción con urgencia responsable'
  ];
  const calendar = [];
  const d = Math.max(1, Math.min(toNum(days, 30), 90));
  const ppd = Math.max(1, Math.min(toNum(posts_per_day, 2), 5));
  for (let day = 1; day <= d; day += 1) {
    for (let slot = 1; slot <= ppd; slot += 1) {
      const format = formats[(day + slot) % formats.length];
      const angle = angles[(day + slot * 2) % angles.length];
      calendar.push({
        day,
        slot,
        format,
        title: `${format}: ${product_focus || 'producto recomendado'} - ${angle}`,
        objective: slot === 1 ? 'atraer y educar' : 'convertir consulta en cotización',
        client_ideal: audience || 'cliente que busca seguridad, energía o instalación confiable',
        CTA: 'Cotiza con REElectrosistemas',
        copy_idea: `Explica ${angle} y conecta la solución con ${product_focus || 'un producto de REElectrosistemas'}.`,
      });
    }
  }
  const hooks = [
    'No compres esto sin verlo',
    'Tu seguridad falla por esto',
    'Esto parece barato, sale caro',
    'El error que nadie revisa',
    'Antes de instalar, mira esto',
    'Tu inversor puede fallar',
    'Cámaras buenas no bastan',
    'Esto protege tu negocio',
    'Lo barato aquí engaña',
    'Este detalle evita problemas'
  ];
  return { calendar, hooks };
}

router.get('/ping', (req, res) => res.json({ ok: true, module: 'crm-marketing', version: 'v60', timestamp: new Date().toISOString() }));
router.use(authMiddleware);

router.get('/crm/labels', (req, res) => {
  try {
    const db = getDb(); ensureSchema(db);
    const labels = db.prepare('SELECT * FROM crm_labels WHERE active = 1 ORDER BY label_type, name').all();
    res.json({ labels });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/crm/labels', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para crear etiquetas' });
    const db = getDb(); ensureSchema(db);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const color = String(req.body.color || '#2563eb').trim();
    const labelType = String(req.body.label_type || 'manual').trim();
    const info = db.prepare('INSERT INTO crm_labels (name, color, label_type, description, created_by) VALUES (?, ?, ?, ?, ?)').run(name, color, labelType, req.body.description || '', req.user.id || null);
    res.json({ success: true, label: db.prepare('SELECT * FROM crm_labels WHERE id = ?').get(info.lastInsertRowid) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.patch('/crm/labels/:id', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para editar etiquetas' });
    const db = getDb(); ensureSchema(db);
    db.prepare('UPDATE crm_labels SET name = COALESCE(?, name), color = COALESCE(?, color), label_type = COALESCE(?, label_type), description = COALESCE(?, description), active = COALESCE(?, active), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.name ?? null, req.body.color ?? null, req.body.label_type ?? null, req.body.description ?? null, req.body.active ?? null, req.params.id);
    res.json({ success: true, label: db.prepare('SELECT * FROM crm_labels WHERE id = ?').get(req.params.id) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.get('/crm/clients', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para CRM' });
    const db = getDb(); ensureSchema(db);
    const cols = getColumns(db, 'clients');
    const nameExpr = clientNameExpr(cols);
    const phoneExpr = clientPhoneExpr(cols);
    const emailExpr = clientEmailExpr(cols);
    const search = String(req.query.search || '').trim();
    const mine = String(req.query.mine || '') === '1';
    const where = [];
    const params = [];
    if (search) {
      where.push(`(${nameExpr} LIKE ? OR ${phoneExpr} LIKE ? OR ${emailExpr} LIKE ? OR COALESCE(crm_notes,'') LIKE ?)`);
      params.push(escLike(search), escLike(search), escLike(search), escLike(search));
    }
    if (mine && !isAdmin(req.user)) { where.push('assigned_user_id = ?'); params.push(req.user.id); }
    const sql = `SELECT id, ${nameExpr} AS name, ${phoneExpr} AS phone, ${emailExpr} AS email, channel, assigned_user_id, assigned_user_name, lifecycle_stage, lead_status, pipeline_status, is_frequent_customer, follow_up_at, last_contacted_at, crm_score, crm_notes, created_at, updated_at FROM clients ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 300`;
    const clients = db.prepare(sql).all(params);
    const labelMap = getLabelsForClients(db, clients.map((c) => c.id));
    res.json({ clients: clients.map((c) => ({ ...c, labels: labelMap[c.id] || [] })) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.patch('/crm/clients/:id', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para editar CRM' });
    const db = getDb(); ensureSchema(db);
    const id = Number(req.params.id);
    const oldClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!oldClient) return res.status(404).json({ error: 'Cliente no encontrado' });
    const assignedUserId = req.body.assigned_user_id === undefined ? oldClient.assigned_user_id : req.body.assigned_user_id;
    const assignedUserName = req.body.assigned_user_name === undefined ? oldClient.assigned_user_name : req.body.assigned_user_name;
    const fields = {
      assigned_user_id: assignedUserId || null,
      assigned_user_name: assignedUserName || '',
      lifecycle_stage: req.body.lifecycle_stage ?? oldClient.lifecycle_stage ?? 'lead',
      lead_status: req.body.lead_status ?? oldClient.lead_status ?? 'new',
      pipeline_status: req.body.pipeline_status ?? oldClient.pipeline_status ?? 'open',
      is_frequent_customer: req.body.is_frequent_customer ?? oldClient.is_frequent_customer ?? 0,
      follow_up_at: req.body.follow_up_at ?? oldClient.follow_up_at ?? '',
      last_contacted_at: req.body.last_contacted_at ?? oldClient.last_contacted_at ?? '',
      crm_score: req.body.crm_score ?? oldClient.crm_score ?? 0,
      crm_notes: req.body.crm_notes ?? oldClient.crm_notes ?? '',
    };
    db.prepare(`UPDATE clients SET assigned_user_id=?, assigned_user_name=?, lifecycle_stage=?, lead_status=?, pipeline_status=?, is_frequent_customer=?, follow_up_at=?, last_contacted_at=?, crm_score=?, crm_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(fields.assigned_user_id, fields.assigned_user_name, fields.lifecycle_stage, fields.lead_status, fields.pipeline_status, fields.is_frequent_customer ? 1 : 0, fields.follow_up_at, fields.last_contacted_at, toNum(fields.crm_score), fields.crm_notes, id);
    db.prepare('INSERT INTO crm_client_events (client_id, event_type, old_value, new_value, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'crm_update', JSON.stringify(oldClient), JSON.stringify(fields), req.body.event_note || '', req.user.id || null);
    res.json({ success: true, client: db.prepare('SELECT * FROM clients WHERE id = ?').get(id) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/crm/clients/:id/labels', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para asignar etiquetas' });
    const db = getDb(); ensureSchema(db);
    const clientId = Number(req.params.id);
    const labelId = Number(req.body.label_id);
    if (!labelId) return res.status(400).json({ error: 'label_id requerido' });
    db.prepare('INSERT OR IGNORE INTO crm_client_labels (client_id, label_id, assigned_by) VALUES (?, ?, ?)').run(clientId, labelId, req.user.id || null);
    db.prepare('INSERT INTO crm_client_events (client_id, event_type, new_value, created_by) VALUES (?, ?, ?, ?)').run(clientId, 'label_added', String(labelId), req.user.id || null);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.delete('/crm/clients/:id/labels/:labelId', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para quitar etiquetas' });
    const db = getDb(); ensureSchema(db);
    db.prepare('DELETE FROM crm_client_labels WHERE client_id = ? AND label_id = ?').run(req.params.id, req.params.labelId);
    db.prepare('INSERT INTO crm_client_events (client_id, event_type, old_value, created_by) VALUES (?, ?, ?, ?)').run(req.params.id, 'label_removed', String(req.params.labelId), req.user.id || null);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.get('/crm/summary', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para ver resumen CRM' });
    const db = getDb(); ensureSchema(db);
    const total = db.prepare('SELECT COUNT(*) AS c FROM clients').get().c;
    const followUp = db.prepare("SELECT COUNT(*) AS c FROM clients WHERE lead_status IN ('follow_up','cotizando') OR pipeline_status IN ('follow_up','proposal')").get().c;
    const frequent = db.prepare('SELECT COUNT(*) AS c FROM clients WHERE is_frequent_customer = 1').get().c;
    const byLabel = db.prepare(`SELECT l.id, l.name, l.color, COUNT(cl.client_id) AS total FROM crm_labels l LEFT JOIN crm_client_labels cl ON cl.label_id = l.id WHERE l.active = 1 GROUP BY l.id ORDER BY total DESC, l.name ASC`).all();
    const byOwner = db.prepare(`SELECT COALESCE(assigned_user_name, 'Sin vendedor') AS owner, COUNT(*) AS total FROM clients GROUP BY COALESCE(assigned_user_name, 'Sin vendedor') ORDER BY total DESC LIMIT 20`).all();
    res.json({ total, follow_up: followUp, frequent, by_label: byLabel, by_owner: byOwner });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.get('/crm/inbox/ownership', (req, res) => {
  try {
    if (!isSales(req.user)) return res.status(403).json({ error: 'Sin permisos para ownership' });
    const db = getDb(); ensureSchema(db);
    if (!tableExists(db, 'conversations')) return res.json({ conversations: [] });
    const cols = getColumns(db, 'conversations');
    const rows = db.prepare(`SELECT * FROM conversations ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 100`).all();
    const conversations = rows.map((r) => ({
      id: r.id,
      client_id: r.client_id || r.customer_id || null,
      client_name: r.client_name || r.customer_name || r.name || 'Cliente',
      channel: r.channel || r.platform || 'chat',
      assigned_user_id: r.assigned_user_id || r.agent_id || r.seller_user_id || null,
      assigned_user_name: r.assigned_user_name || r.agent_name || r.seller_name || 'Sin asignar',
      status: r.status || 'open',
      last_message_at: r.last_message_at || r.updated_at || r.created_at,
    }));
    res.json({ conversations });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/marketing/meta/status', (req, res) => {
  try {
    if (!canUseMarketing(req.user)) return res.status(403).json({ error: 'Sin permisos para Marketing' });
    const db = getDb(); ensureSchema(db);
    const connection = currentConnection(db);
    res.json({ connected: !!connection && connection.status === 'connected', connection, app_configured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/marketing/meta/connect-url', (req, res) => {
  try {
    if (!canUseMarketing(req.user)) return res.status(403).json({ error: 'Sin permisos para conectar Meta' });
    const appId = process.env.META_APP_ID;
    const redirectUri = process.env.META_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/crm-marketing/marketing/meta/callback`;
    if (!appId) return res.status(400).json({ error: 'Falta META_APP_ID en Railway' });
    const scopes = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights', 'ads_read'].join(',');
    const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&response_type=code&state=${encodeURIComponent(String(req.user.id || 'ree'))}`;
    res.json({ url, scopes });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/marketing/meta/manual-token', (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Solo admin puede guardar token Meta manual' });
    const db = getDb(); ensureSchema(db);
    db.prepare(`INSERT INTO meta_connections (name, page_id, page_name, instagram_business_account_id, instagram_username, ad_account_id, access_token, token_expires_at, status, connected_by, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, CURRENT_TIMESTAMP)`).run(
      req.body.name || 'Meta Business', req.body.page_id || '', req.body.page_name || '', req.body.instagram_business_account_id || '', req.body.instagram_username || '', req.body.ad_account_id || '', req.body.access_token || '', req.body.token_expires_at || '', req.user.id || null
    );
    res.json({ success: true, connection: currentConnection(db) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/marketing/meta/disconnect', (req, res) => {
  try {
    if (!canUseMarketing(req.user)) return res.status(403).json({ error: 'Sin permisos para desconectar Meta' });
    const db = getDb(); ensureSchema(db);
    db.prepare("UPDATE meta_connections SET status = 'disconnected', disconnected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM meta_connections ORDER BY id DESC LIMIT 1)").run();
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/marketing/analyze', (req, res) => {
  try {
    if (!canUseMarketing(req.user)) return res.status(403).json({ error: 'Sin permisos para análisis Marketing' });
    const db = getDb(); ensureSchema(db);
    const payload = {
      niche: req.body.niche || '',
      audience: req.body.audience || '',
      product_focus: req.body.product_focus || '',
      goal: req.body.goal || 'ventas',
      posts: Array.isArray(req.body.posts) ? req.body.posts : [],
    };
    const result = analyzePostsLocally(payload);
    const info = db.prepare(`INSERT INTO marketing_analyses (niche, audience, product_focus, goal, posts_json, analysis_text, recommendations_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(payload.niche, payload.audience, payload.product_focus, payload.goal, JSON.stringify(payload.posts), result.analysis, JSON.stringify(result.recommendations), req.user.id || null);
    res.json({ success: true, analysis_id: info.lastInsertRowid, analysis_text: result.analysis, recommendations: result.recommendations, top_posts: result.top_posts });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.post('/marketing/calendar', (req, res) => {
  try {
    if (!canUseMarketing(req.user)) return res.status(403).json({ error: 'Sin permisos para calendario Marketing' });
    const db = getDb(); ensureSchema(db);
    const result = buildCalendar(req.body || {});
    const info = db.prepare(`INSERT INTO marketing_calendars (analysis_id, days, posts_per_day, product_focus, calendar_json, hooks_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.body.analysis_id || null, toNum(req.body.days, 30), toNum(req.body.posts_per_day, 2), req.body.product_focus || '', JSON.stringify(result.calendar), JSON.stringify(result.hooks), req.user.id || null);
    res.json({ success: true, calendar_id: info.lastInsertRowid, calendar: result.calendar, hooks: result.hooks });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.get('/marketing/recommendations', (req, res) => {
  try {
    if (!canUseMarketing(req.user)) return res.status(403).json({ error: 'Sin permisos para recomendaciones' });
    const db = getDb(); ensureSchema(db);
    const products = getProductsForRecommendations(db);
    const recommendations = buildLocalRecommendations(products);
    res.json({ recommendations });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
router.get('/marketing/history', (req, res) => {
  try {
    if (!canUseMarketing(req.user)) return res.status(403).json({ error: 'Sin permisos para historial' });
    const db = getDb(); ensureSchema(db);
    const analyses = db.prepare('SELECT id, niche, audience, product_focus, goal, analysis_text, created_at FROM marketing_analyses ORDER BY id DESC LIMIT 20').all();
    const calendars = db.prepare('SELECT id, analysis_id, days, posts_per_day, product_focus, created_at FROM marketing_calendars ORDER BY id DESC LIMIT 20').all();
    res.json({ analyses, calendars });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
