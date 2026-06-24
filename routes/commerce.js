// routes/commerce.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM commerce_info').all();
  const info = {};
  rows.forEach(r => { info[r.key] = r.value; });
  res.json(info);
});

// Public config endpoint (no auth needed)
router.get('/config', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM commerce_info').all();
  const info = {};
  rows.forEach(r => { info[r.key] = r.value; });
  res.json({
    app_name: info.business_name || 'Mi Empresa',
    logo_url: info.logo_url || null,
    primary_color: info.primary_color || '#3b82f6',
    currency: info.currency_primary || 'DOP',
  });
});

router.put('/', authMiddleware, (req, res) => {
  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO commerce_info (key, value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)');
  const allowed = ['business_name','address','city','country','phone','email','website','facebook','instagram','whatsapp','currency_primary','currency_secondary','rfc','rnc','business_hours','logo_url','description','primary_color'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) stmt.run(key, req.body[key]);
  }
  res.json({ success: true });
});

module.exports = router;
