const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function roleOf(user) { return String(user?.role || '').toLowerCase(); }
function isAdmin(user) { return ['superadmin', 'admin'].includes(roleOf(user)); }
function isInternal(user) { return ['superadmin', 'admin', 'vendedor', 'marketing', 'contabilidad', 'accounting'].includes(roleOf(user)); }
function isTechnician(user) { return ['tecnico', 'técnico', 'technician'].includes(roleOf(user)); }
function nowIso() { return new Date().toISOString(); }
function safeJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function toJson(value) { return JSON.stringify(value || null); }
function cleanText(value, max = 3000) { return String(value || '').trim().slice(0, max); }
function toNum(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function escLike(value) { return `%${String(value || '').trim().replace(/[%_]/g, '')}%`; }

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

const DEFAULT_SETTINGS = {
  personality: {
    name: 'REE Asistente IA',
    tone: 'profesional, claro, vendedor y técnico cuando sea necesario',
    greeting: 'Hola, soy el asistente de REElectrosistemas. ¿Qué producto o solución estás buscando?',
    fallback: 'No tengo esa información confirmada ahora mismo, pero puedo conectarte con un asesor.',
    forbidden: 'No revelar costos internos, márgenes, proveedores, tokens, datos privados ni precios técnicos fuera del catálogo técnico.',
    style: 'Responde breve, con seguridad, sin inventar datos y siempre orientado a la siguiente acción comercial.'
  },
  business: {
    company_name: 'REElectrosistemas',
    value_proposition: 'Soluciones de seguridad electrónica, energía, inversores, cámaras, alarmas y productos técnicos.',
    sales_focus: 'orientar, recomendar productos adecuados y convertir consultas en leads u órdenes',
    warranty_policy: '',
    payment_policy: '',
    delivery_policy: ''
  },
  visibility: {
    internal_app: true,
    technician_catalog: true,
    public_web: true,
    woocommerce: true,
    product_pages: true,
    whatsapp: false,
    instagram: false,
    messenger: false
  },
  pricing: {
    public_context: 'sale_price_or_regular_price',
    technician_context: 'technician_price',
    internal_context: 'role_based',
    hide_costs_always: true
  },
  assignment: {
    mode: 'round_robin',
    default_vendor_id: '',
    default_vendor_name: '',
    notify_channel: 'inbox',
    product_category_rules: []
  },
  widget: {
    enabled: true,
    position: 'bottom-right',
    accent_color: '#2563eb',
    title: 'REE Asistente IA',
    subtitle: 'Te ayudo a elegir el producto correcto',
    collect_name: true,
    collect_phone: true,
    show_interest_button: true,
    public_allowed_domains: ['reelectrosistemas.com'],
    welcome_options: ['Quiero una cámara', 'Necesito un inversor', 'Paneles solares', 'Hablar con un asesor']
  },
  product_rules: {
    only_show_ready_products_public: true,
    show_backorder_public: false,
    allow_technician_backorder: true,
    max_recommendations: 5
  }
};

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_assistant_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_assistant_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      visibility TEXT DEFAULT 'all',
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_assistant_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      context TEXT DEFAULT 'internal',
      user_id INTEGER,
      client_id INTEGER,
      visitor_name TEXT,
      visitor_phone TEXT,
      last_message TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_assistant_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      role TEXT,
      content TEXT,
      products_json TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_interest_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT DEFAULT 'ai_widget',
      context TEXT DEFAULT 'public_web',
      session_id TEXT,
      client_id INTEGER,
      visitor_name TEXT,
      visitor_phone TEXT,
      visitor_email TEXT,
      product_id INTEGER,
      product_name TEXT,
      sku TEXT,
      message TEXT,
      assigned_vendor_id INTEGER,
      assigned_vendor_name TEXT,
      status TEXT DEFAULT 'new',
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  if (!tableExists(db, 'clients')) {
    db.exec(`CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      email TEXT,
      channel TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);
  }
  addColumnIfMissing(db, 'clients', 'assigned_user_id', 'INTEGER');
  addColumnIfMissing(db, 'clients', 'assigned_user_name', 'TEXT');
  addColumnIfMissing(db, 'clients', 'lifecycle_stage', "TEXT DEFAULT 'lead'");
  addColumnIfMissing(db, 'clients', 'lead_status', "TEXT DEFAULT 'new'");
  addColumnIfMissing(db, 'clients', 'pipeline_status', "TEXT DEFAULT 'open'");
  addColumnIfMissing(db, 'clients', 'is_frequent_customer', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'clients', 'crm_notes', 'TEXT');
  addColumnIfMissing(db, 'clients', 'last_contacted_at', 'TEXT');

  const existing = db.prepare('SELECT id FROM ai_assistant_settings WHERE id=1').get();
  if (!existing) {
    db.prepare('INSERT INTO ai_assistant_settings (id, settings_json, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)').run(toJson(DEFAULT_SETTINGS));
  }
}

function getSettings(db) {
  ensureSchema(db);
  const row = db.prepare('SELECT settings_json FROM ai_assistant_settings WHERE id=1').get();
  return Object.assign({}, DEFAULT_SETTINGS, safeJson(row?.settings_json, DEFAULT_SETTINGS));
}

function deepMerge(target, source) {
  const output = Array.isArray(target) ? [...target] : { ...(target || {}) };
  Object.keys(source || {}).forEach((key) => {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      output[key] = deepMerge(output[key] || {}, source[key]);
    } else {
      output[key] = source[key];
    }
  });
  return output;
}

function saveSettings(db, settings, userId) {
  ensureSchema(db);
  const merged = deepMerge(DEFAULT_SETTINGS, settings || {});
  db.prepare('UPDATE ai_assistant_settings SET settings_json=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=1').run(toJson(merged), userId || null);
  return merged;
}

function selectVendor(db, settings, product = {}) {
  const mode = String(settings?.assignment?.mode || 'round_robin');
  const defaultId = toNum(settings?.assignment?.default_vendor_id, 0);
  if (defaultId > 0) {
    try {
      const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(defaultId);
      if (u) return { id: u.id, name: u.name || u.email || `Vendedor #${u.id}` };
    } catch {}
  }

  try {
    const rules = Array.isArray(settings?.assignment?.product_category_rules) ? settings.assignment.product_category_rules : [];
    const category = String(product.category_name || product.category || '').toLowerCase();
    const match = rules.find((r) => category && String(r.category || '').toLowerCase() === category && r.vendor_id);
    if (match) {
      const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(toNum(match.vendor_id));
      if (u) return { id: u.id, name: u.name || u.email || `Vendedor #${u.id}` };
    }
  } catch {}

  try {
    const users = db.prepare("SELECT id, name, email FROM users WHERE LOWER(role) IN ('vendedor','admin','superadmin') ORDER BY id ASC").all();
    if (users.length) {
      const last = db.prepare('SELECT assigned_vendor_id FROM ai_interest_leads WHERE assigned_vendor_id IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      if (mode === 'round_robin' && last?.assigned_vendor_id) {
        const idx = users.findIndex((u) => Number(u.id) === Number(last.assigned_vendor_id));
        const next = users[(idx + 1) % users.length] || users[0];
        return { id: next.id, name: next.name || next.email || `Vendedor #${next.id}` };
      }
      const u = users[0];
      return { id: u.id, name: u.name || u.email || `Vendedor #${u.id}` };
    }
  } catch {}
  return { id: null, name: settings?.assignment?.default_vendor_name || 'Sin vendedor asignado' };
}

function productBaseQuery(context, limit) {
  const isTech = context === 'technician';
  const priceExpr = isTech ? 'COALESCE(NULLIF(technician_price,0), sale_price, price, regular_price, 0)' : 'COALESCE(NULLIF(sale_price,0), price, regular_price, 0)';
  return `
    SELECT id, name, sku, model, short_description, description, brand_id, category_id,
           category_name, brand_name, stock_quantity, stock_status, commercial_status,
           web_work_status, is_visible_to_technicians, technician_can_order,
           main_image, image_url, image, ${priceExpr} AS display_price,
           technician_price, price, sale_price, regular_price
    FROM products
    WHERE 1=1
      ${isTech ? 'AND COALESCE(is_visible_to_technicians,0)=1' : ""}
    ORDER BY COALESCE(stock_quantity,0) DESC, id DESC
    LIMIT ${Math.max(1, Math.min(Number(limit) || 5, 10))}`;
}

function searchProducts(db, query, context, limit = 5) {
  if (!tableExists(db, 'products')) return [];
  const isTech = context === 'technician';
  const priceExpr = isTech ? 'COALESCE(NULLIF(technician_price,0), sale_price, price, regular_price, 0)' : 'COALESCE(NULLIF(sale_price,0), price, regular_price, 0)';
  const like = escLike(query);
  try {
    const rows = db.prepare(`
      SELECT id, name, sku, model, short_description, description, brand_id, category_id,
             category_name, brand_name, stock_quantity, stock_status, commercial_status,
             web_work_status, is_visible_to_technicians, technician_can_order,
             main_image, image_url, image, ${priceExpr} AS display_price,
             technician_price, price, sale_price, regular_price
      FROM products
      WHERE (name LIKE ? OR sku LIKE ? OR model LIKE ? OR short_description LIKE ? OR description LIKE ?)
        ${isTech ? 'AND COALESCE(is_visible_to_technicians,0)=1' : ''}
      ORDER BY
        CASE WHEN name LIKE ? THEN 0 ELSE 1 END,
        COALESCE(stock_quantity,0) DESC,
        id DESC
      LIMIT ?
    `).all(like, like, like, like, like, like, Math.max(1, Math.min(Number(limit) || 5, 10)));
    if (rows.length) return rows;
    return db.prepare(productBaseQuery(context, limit)).all();
  } catch (error) {
    return [];
  }
}

function publicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    model: product.model,
    description: product.short_description || product.description || '',
    price: toNum(product.display_price, 0),
    stock_quantity: toNum(product.stock_quantity, 0),
    stock_status: product.stock_status,
    commercial_status: product.commercial_status,
    image: product.main_image || product.image_url || product.image || '',
    interest_label: 'Me interesa'
  };
}

function knowledgeForContext(db, context) {
  try {
    return db.prepare(`
      SELECT title, content, category, visibility
      FROM ai_assistant_knowledge
      WHERE active=1 AND (visibility='all' OR visibility=? OR visibility IS NULL)
      ORDER BY id DESC
      LIMIT 10
    `).all(context || 'internal');
  } catch { return []; }
}

function localAnswer({ message, context, settings, products, knowledge }) {
  const productLines = products.map((p, i) => `${i + 1}. ${p.name}${p.sku ? ` (${p.sku})` : ''} - Precio: RD$ ${Number(p.display_price || 0).toLocaleString('es-DO')} - Stock: ${p.stock_quantity ?? 'N/D'}`).join('\n');
  const knowledgeHint = knowledge.slice(0, 3).map((k) => `${k.title}: ${k.content}`).join('\n');
  const isTech = context === 'technician';
  const isPublic = context === 'public_web' || context === 'woocommerce';
  let intro = settings?.personality?.greeting || 'Hola, soy el asistente IA.';
  if (message) intro = 'Te ayudo con esto.';
  let body = '';
  if (products.length) {
    body = isTech
      ? `Encontré estas opciones con precio técnico:\n${productLines}\n\nPuedes seleccionar “Me interesa” o agregarlo a tu pedido técnico.`
      : `Encontré estas opciones que pueden ayudarte:\n${productLines}\n\nSi alguna te interesa, toca “Me interesa” y te conecto con un asesor.`;
  } else {
    body = `No encontré un producto exacto. ${settings?.personality?.fallback || 'Puedo conectarte con un asesor para confirmar la mejor opción.'}`;
  }
  if (knowledgeHint && !isPublic) body += `\n\nDato interno útil:\n${knowledgeHint.slice(0, 700)}`;
  return `${intro}\n\n${body}`;
}

async function aiAnswer(payload) {
  const { message, context, settings, products, knowledge } = payload;
  if (!process.env.OPENAI_API_KEY) return localAnswer(payload);
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const system = [
      `Eres ${settings.personality.name || 'REE Asistente IA'}.`,
      `Tono: ${settings.personality.tone}.`,
      `Reglas: ${settings.personality.forbidden}.`,
      `Contexto: ${context}.`,
      context === 'technician' ? 'El usuario es técnico: solo muestra precio técnico y productos autorizados.' : '',
      context === 'public_web' || context === 'woocommerce' ? 'Usuario público: solo mostrar precio normal/de venta, nunca costo ni precio técnico.' : '',
      'No inventes stock, precio, garantía ni disponibilidad.',
      'Si recomiendas productos, invita a tocar “Me interesa”.'
    ].filter(Boolean).join('\n');
    const compactProducts = products.map(publicProduct);
    const compactKnowledge = knowledge.map((k) => ({ title: k.title, content: k.content.slice(0, 1000), category: k.category }));
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ message, products: compactProducts, knowledge: compactKnowledge }) }
      ],
      temperature: 0.45,
      max_tokens: 700
    });
    return completion.choices?.[0]?.message?.content || localAnswer(payload);
  } catch (error) {
    return localAnswer(payload);
  }
}

function createConversation(db, { session_id, context, user_id, visitor_name, visitor_phone, message, metadata }) {
  ensureSchema(db);
  const existing = session_id ? db.prepare('SELECT * FROM ai_assistant_conversations WHERE session_id=? AND context=? ORDER BY id DESC LIMIT 1').get(session_id, context) : null;
  if (existing) {
    db.prepare('UPDATE ai_assistant_conversations SET last_message=?, visitor_name=COALESCE(?, visitor_name), visitor_phone=COALESCE(?, visitor_phone), metadata_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(message || '', visitor_name || null, visitor_phone || null, toJson(metadata || {}), existing.id);
    return existing.id;
  }
  const info = db.prepare(`INSERT INTO ai_assistant_conversations (session_id, context, user_id, visitor_name, visitor_phone, last_message, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(session_id || `sess_${Date.now()}`, context, user_id || null, visitor_name || null, visitor_phone || null, message || '', toJson(metadata || {}));
  return info.lastInsertRowid;
}

async function handleMessage(req, res, context) {
  const db = getDb();
  ensureSchema(db);
  const settings = getSettings(db);
  const message = cleanText(req.body.message, 2000);
  const session_id = cleanText(req.body.session_id || req.body.sessionId, 120) || `sess_${Date.now()}`;
  const visitor_name = cleanText(req.body.visitor_name || req.body.name, 120);
  const visitor_phone = cleanText(req.body.visitor_phone || req.body.phone, 80);
  const query = req.body.product_query || message;
  const products = searchProducts(db, query, context, settings?.product_rules?.max_recommendations || 5);
  const knowledge = knowledgeForContext(db, context);
  const conversationId = createConversation(db, { session_id, context, user_id: req.user?.id, visitor_name, visitor_phone, message, metadata: req.body.metadata || {} });
  db.prepare('INSERT INTO ai_assistant_messages (conversation_id, role, content, metadata_json) VALUES (?, ?, ?, ?)').run(conversationId, 'user', message, toJson(req.body.metadata || {}));
  const answer = await aiAnswer({ message, context, settings, products, knowledge });
  db.prepare('INSERT INTO ai_assistant_messages (conversation_id, role, content, products_json, metadata_json) VALUES (?, ?, ?, ?, ?)').run(conversationId, 'assistant', answer, toJson(products.map(publicProduct)), toJson({ context }));
  res.json({
    ok: true,
    conversation_id: conversationId,
    session_id,
    context,
    answer,
    products: products.map(publicProduct),
    interest_enabled: settings?.widget?.show_interest_button !== false
  });
}

function upsertClientFromLead(db, lead) {
  ensureSchema(db);
  const phone = cleanText(lead.visitor_phone, 80);
  const email = cleanText(lead.visitor_email, 160);
  const name = cleanText(lead.visitor_name, 160) || 'Lead desde IA';
  let client = null;
  if (phone) client = db.prepare('SELECT * FROM clients WHERE phone=? ORDER BY id DESC LIMIT 1').get(phone);
  if (!client && email) client = db.prepare('SELECT * FROM clients WHERE email=? ORDER BY id DESC LIMIT 1').get(email);
  if (client) {
    db.prepare(`UPDATE clients SET name=COALESCE(NULLIF(?,''), name), assigned_user_id=?, assigned_user_name=?, lifecycle_stage='lead', lead_status='interested', pipeline_status='open', last_contacted_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(name, lead.assigned_vendor_id || null, lead.assigned_vendor_name || null, nowIso(), client.id);
    return client.id;
  }
  const info = db.prepare(`INSERT INTO clients (name, phone, email, channel, assigned_user_id, assigned_user_name, lifecycle_stage, lead_status, pipeline_status, crm_notes, last_contacted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'lead', 'interested', 'open', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(
      name,
      phone || null,
      email || null,
      lead.context || 'ai_widget',
      lead.assigned_vendor_id || null,
      lead.assigned_vendor_name || null,
      `Interesado vía IA en: ${lead.product_name || lead.sku || 'producto'}. ${lead.message || ''}`,
      nowIso()
    );
  return info.lastInsertRowid;
}

router.get('/ping', (req, res) => {
  res.json({ ok: true, module: 'ai-assistant-control', version: 'v62', timestamp: nowIso() });
});

router.get('/public/settings', (req, res) => {
  const db = getDb();
  const settings = getSettings(db);
  res.json({
    ok: true,
    widget: settings.widget,
    visibility: settings.visibility,
    business: { company_name: settings.business.company_name, value_proposition: settings.business.value_proposition },
    assistant: { name: settings.personality.name, greeting: settings.personality.greeting }
  });
});

router.post('/public/message', (req, res, next) => handleMessage(req, res, cleanText(req.body.context, 80) || 'public_web').catch(next));

router.post('/public/interest', (req, res, next) => {
  try {
    const db = getDb();
    ensureSchema(db);
    const settings = getSettings(db);
    const product_id = toNum(req.body.product_id, 0) || null;
    let product = null;
    if (product_id && tableExists(db, 'products')) {
      product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    }
    const vendor = selectVendor(db, settings, product || {});
    const lead = {
      source: cleanText(req.body.source || 'ai_widget', 80),
      context: cleanText(req.body.context || 'public_web', 80),
      session_id: cleanText(req.body.session_id, 120),
      visitor_name: cleanText(req.body.visitor_name || req.body.name, 160),
      visitor_phone: cleanText(req.body.visitor_phone || req.body.phone, 80),
      visitor_email: cleanText(req.body.visitor_email || req.body.email, 160),
      product_id,
      product_name: cleanText(req.body.product_name || product?.name, 240),
      sku: cleanText(req.body.sku || product?.sku, 120),
      message: cleanText(req.body.message || 'Me interesa este producto', 1000),
      assigned_vendor_id: vendor.id,
      assigned_vendor_name: vendor.name
    };
    const clientId = upsertClientFromLead(db, lead);
    const info = db.prepare(`INSERT INTO ai_interest_leads (source, context, session_id, client_id, visitor_name, visitor_phone, visitor_email, product_id, product_name, sku, message, assigned_vendor_id, assigned_vendor_name, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(
      lead.source, lead.context, lead.session_id || null, clientId, lead.visitor_name || null, lead.visitor_phone || null, lead.visitor_email || null,
      lead.product_id, lead.product_name || null, lead.sku || null, lead.message || null, lead.assigned_vendor_id || null, lead.assigned_vendor_name || null, toJson(req.body.metadata || {})
    );
    res.json({ ok: true, lead_id: info.lastInsertRowid, client_id: clientId, assigned_vendor_id: vendor.id, assigned_vendor_name: vendor.name, message: 'Perfecto, ya conectamos tu interés con un asesor.' });
  } catch (error) { next(error); }
});

router.use(authMiddleware);

router.get('/settings', (req, res) => {
  const db = getDb();
  res.json({ ok: true, settings: getSettings(db) });
});

router.put('/settings', (req, res) => {
  if (!isAdmin(req.user) && roleOf(req.user) !== 'marketing') return res.status(403).json({ error: 'No tienes permiso para configurar el asistente IA.' });
  const db = getDb();
  const current = getSettings(db);
  const next = deepMerge(current, req.body.settings || req.body || {});
  res.json({ ok: true, settings: saveSettings(db, next, req.user?.id) });
});

router.get('/knowledge', (req, res) => {
  if (!isInternal(req.user)) return res.status(403).json({ error: 'No autorizado.' });
  const db = getDb();
  ensureSchema(db);
  const rows = db.prepare('SELECT * FROM ai_assistant_knowledge ORDER BY active DESC, id DESC LIMIT 200').all();
  res.json({ ok: true, knowledge: rows });
});

router.post('/knowledge', (req, res) => {
  if (!isAdmin(req.user) && roleOf(req.user) !== 'marketing') return res.status(403).json({ error: 'No tienes permiso para entrenar el asistente.' });
  const db = getDb();
  ensureSchema(db);
  const title = cleanText(req.body.title, 180);
  const content = cleanText(req.body.content, 8000);
  if (!title || !content) return res.status(400).json({ error: 'Título y contenido son obligatorios.' });
  const info = db.prepare(`INSERT INTO ai_assistant_knowledge (title, content, category, visibility, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(
    title, content, cleanText(req.body.category || 'general', 80), cleanText(req.body.visibility || 'all', 80), Number(req.body.active ?? 1), req.user?.id || null
  );
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.patch('/knowledge/:id', (req, res) => {
  if (!isAdmin(req.user) && roleOf(req.user) !== 'marketing') return res.status(403).json({ error: 'No autorizado.' });
  const db = getDb();
  ensureSchema(db);
  db.prepare('UPDATE ai_assistant_knowledge SET title=COALESCE(?, title), content=COALESCE(?, content), category=COALESCE(?, category), visibility=COALESCE(?, visibility), active=COALESCE(?, active), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
    req.body.title ?? null, req.body.content ?? null, req.body.category ?? null, req.body.visibility ?? null, req.body.active ?? null, req.params.id
  );
  res.json({ ok: true });
});

router.delete('/knowledge/:id', (req, res) => {
  if (!isAdmin(req.user) && roleOf(req.user) !== 'marketing') return res.status(403).json({ error: 'No autorizado.' });
  const db = getDb();
  ensureSchema(db);
  db.prepare('DELETE FROM ai_assistant_knowledge WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/internal/message', (req, res, next) => {
  if (!isInternal(req.user)) return res.status(403).json({ error: 'No autorizado.' });
  handleMessage(req, res, 'internal').catch(next);
});

router.post('/technician/message', (req, res, next) => {
  if (!isTechnician(req.user)) return res.status(403).json({ error: 'Solo técnicos.' });
  handleMessage(req, res, 'technician').catch(next);
});

router.post('/test', (req, res, next) => {
  if (!isInternal(req.user)) return res.status(403).json({ error: 'No autorizado.' });
  const context = cleanText(req.body.context || 'internal', 80);
  handleMessage(req, res, context).catch(next);
});

router.get('/leads', (req, res) => {
  if (!isInternal(req.user)) return res.status(403).json({ error: 'No autorizado.' });
  const db = getDb();
  ensureSchema(db);
  const rows = db.prepare('SELECT * FROM ai_interest_leads ORDER BY id DESC LIMIT 200').all();
  res.json({ ok: true, leads: rows });
});

router.patch('/leads/:id', (req, res) => {
  if (!isInternal(req.user)) return res.status(403).json({ error: 'No autorizado.' });
  const db = getDb();
  ensureSchema(db);
  db.prepare('UPDATE ai_interest_leads SET status=COALESCE(?, status), assigned_vendor_id=COALESCE(?, assigned_vendor_id), assigned_vendor_name=COALESCE(?, assigned_vendor_name), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
    req.body.status ?? null, req.body.assigned_vendor_id ?? null, req.body.assigned_vendor_name ?? null, req.params.id
  );
  res.json({ ok: true });
});

router.get('/embed-code', (req, res) => {
  const base = process.env.PUBLIC_WIDGET_BASE_URL || process.env.FRONTEND_URL || 'https://reelectrosistemas.com/app';
  res.json({
    ok: true,
    code: `<script src="${base.replace(/\/$/, '')}/assets/ree-ai-widget.js" data-company="reelectrosistemas" data-context="public_web" data-api-base="${process.env.PUBLIC_API_BASE_URL || 'https://ree-backend-production.up.railway.app'}"></script>`
  });
});

module.exports = router;
