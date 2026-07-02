
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
const SECRET_MASK = '••••••••';

const DEFAULT_INTEGRATIONS = [
  { name: 'Claude AI', type: 'claude_ai', category: 'ai', config: { model: 'claude-haiku-4-5-20251001' } },
  { name: 'ChatGPT / OpenAI', type: 'openai', category: 'ai', config: { model: 'gpt-4o-mini' } },
  { name: 'OpenAI Imágenes', type: 'openai_images', category: 'image_ai', config: { model: 'gpt-image-1', size: '1024x1024' } },
  { name: 'WooCommerce REST API', type: 'woocommerce', category: 'ecommerce', config: {} },
  { name: 'WordPress', type: 'wordpress', category: 'ecommerce', config: {} },
  { name: 'WhatsApp Business', type: 'whatsapp', category: 'messaging', config: {} },
  { name: 'Facebook Messenger', type: 'messenger', category: 'messaging', config: {} },
  { name: 'Instagram DM', type: 'instagram_dm', category: 'messaging', config: {} },
  { name: 'Meta Ads', type: 'meta_ads', category: 'marketing', config: {} },
  { name: 'Google Ads', type: 'google_ads', category: 'marketing', config: {} }
];

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[\/\-\s]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function normalizeType(value) {
  const clean = normalizeText(value);
  const aliases = {
    claude: 'claude_ai', anthropic: 'claude_ai', claude_ai: 'claude_ai', claude_ia: 'claude_ai',
    openai: 'openai', chatgpt: 'openai', gpt: 'openai',
    openai_images: 'openai_images', image_ai: 'openai_images', imagenes: 'openai_images',
    woo: 'woocommerce', woocommerce: 'woocommerce', wordpress: 'wordpress', wp: 'wordpress',
    whatsapp: 'whatsapp', instagram: 'instagram_dm', instagram_dm: 'instagram_dm', messenger: 'messenger', meta: 'meta_ads', meta_ads: 'meta_ads', google_ads: 'google_ads'
  };
  return aliases[clean] || clean;
}

function getColumns(db, table) { try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; } }
function addColumnIfMissing(db, table, col, def) { const cols = getColumns(db, table); if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
function ensureSettings(db) { db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)'); }
function getSetting(db, key, fallback = '') { try { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || fallback; } catch { return fallback; } }
function saveSetting(db, key, value) { ensureSettings(db); db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, value || ''); }
function parseConfig(v) { try { return typeof v === 'object' && v ? v : JSON.parse(v || '{}'); } catch { return {}; } }
function defaultFor(type) { return DEFAULT_INTEGRATIONS.find((i) => i.type === type) || { name: type, type, category: 'other', config: {} }; }

function ensureIntegrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    type TEXT,
    category TEXT DEFAULT 'other',
    is_connected INTEGER DEFAULT 0,
    config TEXT DEFAULT '{}',
    webhook_url TEXT,
    connected_at DATETIME,
    created_at DATETIME,
    updated_at DATETIME
  )`);
  ['name TEXT','type TEXT','category TEXT DEFAULT \'other\'','is_connected INTEGER DEFAULT 0','config TEXT DEFAULT \'{}\'','webhook_url TEXT','connected_at DATETIME','created_at DATETIME','updated_at DATETIME'].forEach((d) => {
    const [col, ...rest] = d.split(' ');
    addColumnIfMissing(db, 'integrations', col, rest.join(' '));
  });
  DEFAULT_INTEGRATIONS.forEach((item) => {
    const existing = db.prepare('SELECT rowid,* FROM integrations WHERE type=? LIMIT 1').get(item.type);
    if (existing) {
      db.prepare('UPDATE integrations SET name=?, category=?, updated_at=CURRENT_TIMESTAMP WHERE rowid=?').run(item.name, item.category, existing.rowid);
    } else {
      db.prepare('INSERT INTO integrations (name,type,category,config,is_connected,created_at,updated_at) VALUES (?,?,?,?,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)').run(item.name, item.type, item.category, JSON.stringify(item.config || {}));
    }
  });
}

function mask(row) {
  const config = parseConfig(row.config);
  ['api_key','apiKey','key','token','secret','value','access_token','anthropic_key','claude_key','openai_key','wc_secret','woo_secret'].forEach((k) => { if (config[k]) config[k] = SECRET_MASK; });
  return { ...row, type: normalizeType(row.type), is_connected: Number(row.is_connected || 0) === 1, config };
}

function findIntegration(db, idOrType) {
  ensureIntegrations(db);
  const clean = String(idOrType || '').trim();
  const type = normalizeType(clean);
  const rows = db.prepare('SELECT rowid,* FROM integrations').all();
  let row = rows.find((r) => String(r.id) === clean || String(r.rowid) === clean || normalizeType(r.type) === type || normalizeText(r.name) === normalizeText(clean));
  if (!row) {
    const def = defaultFor(type);
    const result = db.prepare('INSERT INTO integrations (name,type,category,config,is_connected,created_at,updated_at) VALUES (?,?,?,?,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)').run(def.name, def.type, def.category, JSON.stringify(def.config || {}));
    row = db.prepare('SELECT rowid,* FROM integrations WHERE rowid=?').get(result.lastInsertRowid);
  }
  return row;
}

function mergeConfig(existing, body = {}) {
  const config = { ...(existing || {}), ...(body.config || {}) };
  ['api_key','apiKey','anthropic_key','claude_key','openai_key','chatgpt_key','key','token','value','secret','model','url','wc_url','woo_url','wc_key','woo_key','wc_secret','woo_secret','access_token','phone_number_id','app_secret'].forEach((k) => {
    if (body[k] && body[k] !== SECRET_MASK) config[k] = body[k];
  });
  return config;
}

function saveIntegration(db, rowid, config, connected, webhook_url = '') {
  db.prepare(`UPDATE integrations SET config=?, is_connected=?, webhook_url=?, connected_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE connected_at END, updated_at=CURRENT_TIMESTAMP WHERE rowid=?`)
    .run(JSON.stringify(config || {}), connected ? 1 : 0, webhook_url || '', connected ? 1 : 0, rowid);
  return db.prepare('SELECT rowid,* FROM integrations WHERE rowid=?').get(rowid);
}

function extractClaudeKey(config, db) {
  const raw = config.api_key || config.apiKey || config.anthropic_key || config.claude_key || config.key || config.token || config.value || config.secret || getSetting(db, 'anthropic_key', '') || process.env.ANTHROPIC_API_KEY || '';
  const match = String(raw || '').trim().match(/sk-ant-[A-Za-z0-9_\-]+/);
  return match ? match[0] : String(raw || '').trim();
}

async function testClaude(config, db) {
  const apiKey = extractClaudeKey(config, db);
  if (!apiKey || !apiKey.startsWith('sk-ant-')) throw new Error('Falta una API Key válida de Claude / Anthropic. Debe empezar con sk-ant-.');
  const model = config.model || getSetting(db, 'claude_model', '') || 'claude-haiku-4-5-20251001';
  const client = new Anthropic({ apiKey });
  await client.messages.create({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Responde solamente: conectado.' }] });
  saveSetting(db, 'anthropic_key', apiKey);
  saveSetting(db, 'claude_model', model);
  saveSetting(db, 'ai_model', model);
  return 'Claude AI conectado correctamente.';
}

async function testOpenAI(config, db) {
  const raw = config.api_key || config.apiKey || config.openai_key || config.chatgpt_key || config.key || config.token || config.value || config.secret || getSetting(db, 'openai_key', '') || process.env.OPENAI_API_KEY || '';
  const apiKey = String(raw || '').trim();
  if (!apiKey || !apiKey.startsWith('sk-')) throw new Error('Falta una API Key válida de OpenAI. Debe empezar con sk-.');
  await axios.get('https://api.openai.com/v1/models', { timeout: 30000, headers: { Authorization: `Bearer ${apiKey}` } });
  saveSetting(db, 'openai_key', apiKey);
  return 'OpenAI conectado correctamente.';
}

function normalizeUrl(url) { const v = String(url || '').trim(); if (!v) return ''; return (v.startsWith('http') ? v : `https://${v}`).replace(/\/+$/, ''); }
async function testWoo(config, db) {
  const url = normalizeUrl(config.wc_url || config.woo_url || config.url || getSetting(db, 'wc_url', '') || process.env.WC_URL || '');
  const key = String(config.wc_key || config.woo_key || config.key || getSetting(db, 'wc_key', '') || process.env.WC_KEY || '').trim();
  const secret = String(config.wc_secret || config.woo_secret || config.secret || getSetting(db, 'wc_secret', '') || process.env.WC_SECRET || '').trim();
  if (!url || !key || !secret) throw new Error('Faltan URL, Consumer Key o Consumer Secret de WooCommerce.');
  const res = await axios.get(`${url}/wp-json/wc/v3/products`, { timeout: 30000, params: { per_page: 1 }, auth: { username: key, password: secret } });
  saveSetting(db, 'wc_url', url); saveSetting(db, 'wc_key', key); saveSetting(db, 'wc_secret', secret);
  return `WooCommerce conectado correctamente. Productos detectados: ${res.headers['x-wp-total'] || '?'}.`;
}

async function handleConnect(req, res, shouldConnect = true) {
  try {
    const db = getDb(); ensureSettings(db); ensureIntegrations(db);
    const row = findIntegration(db, req.params.id);
    const type = normalizeType(row.type);
    const config = mergeConfig(parseConfig(row.config), req.body || {});
    let message = 'Integración guardada para configuración manual.';
    let connected = !!req.body.force_connected || shouldConnect;
    if (type === 'claude_ai') message = await testClaude(config, db);
    else if (type === 'openai' || type === 'openai_images') message = await testOpenAI(config, db);
    else if (type === 'woocommerce') message = await testWoo(config, db);
    else connected = !!req.body.force_connected;
    const updated = saveIntegration(db, row.rowid, config, connected, req.body.webhook_url || row.webhook_url || '');
    res.json({ success: true, message, integration: mask(updated) });
  } catch (error) {
    console.error('[integrations] error:', error.response?.data || error.message);
    res.status(400).json({ success: false, error: error.response?.data?.message || error.response?.data?.error?.message || error.message });
  }
}

router.get('/', authMiddleware, (req, res) => {
  try { const db = getDb(); ensureSettings(db); ensureIntegrations(db); res.json(db.prepare('SELECT rowid,* FROM integrations ORDER BY category,name').all().map(mask)); }
  catch (e) { res.status(500).json({ error: 'Error cargando integraciones: ' + e.message }); }
});
router.post('/bootstrap', authMiddleware, requireRole('admin','superadmin'), (req,res)=>{
  try { const db=getDb(); ensureSettings(db); ensureIntegrations(db); res.json({ success:true, message:'Integraciones restauradas correctamente.', integrations: db.prepare('SELECT rowid,* FROM integrations ORDER BY category,name').all().map(mask) }); }
  catch(e){ res.status(500).json({ error:'Error restaurando integraciones: '+e.message }); }
});
router.get('/:id', authMiddleware, (req,res)=>{ try{ const db=getDb(); res.json(mask(findIntegration(db, req.params.id))); }catch(e){ res.status(500).json({error:e.message}); } });
router.put('/:id', authMiddleware, requireRole('admin','superadmin'), (req,res)=>{
  try{ const db=getDb(); const row=findIntegration(db, req.params.id); const config=mergeConfig(parseConfig(row.config), req.body||{}); const updated=saveIntegration(db,row.rowid,config,req.body.is_connected===undefined?Number(row.is_connected||0)===1:!!req.body.is_connected,req.body.webhook_url||row.webhook_url||''); res.json({success:true,message:'Integración guardada correctamente.',integration:mask(updated)}); }catch(e){ res.status(500).json({error:'Error guardando integración: '+e.message}); }
});
router.post('/:id/connect', authMiddleware, requireRole('admin','superadmin'), (req,res)=>handleConnect(req,res,true));
router.post('/:id/test', authMiddleware, requireRole('admin','superadmin'), (req,res)=>handleConnect(req,res,true));
router.post('/:id/disconnect', authMiddleware, requireRole('admin','superadmin'), (req,res)=>{
  try{ const db=getDb(); const row=findIntegration(db, req.params.id); db.prepare('UPDATE integrations SET is_connected=0,connected_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE rowid=?').run(row.rowid); res.json({success:true,message:'Integración desconectada correctamente.'}); }catch(e){ res.status(500).json({error:'Error desconectando integración: '+e.message}); }
});

module.exports = router;
