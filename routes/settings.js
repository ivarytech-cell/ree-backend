const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/settings
router.get('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  // No devolver secrets directamente
  if (settings.wc_secret) settings.wc_secret = '••••••••';
  res.json(settings);
});

// PUT /api/settings - actualizar configuración
router.put('/', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  const allowed = ['wc_url', 'wc_key', 'wc_secret', 'anthropic_key', 'app_name', 'app_logo'];
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const updated = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key) && value !== '••••••••') {
      stmt.run(key, value);
      updated.push(key);
    }
  }

  res.json({ message: 'Configuración guardada', updated });
});

// GET /api/settings/attributes - plantillas de atributos
router.get('/attributes', authMiddleware, (req, res) => {
  const db = getDb();
  const attrs = db.prepare('SELECT * FROM attribute_templates ORDER BY name').all();
  res.json(attrs);
});

// POST /api/settings/attributes
router.post('/attributes', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const { name, unit } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const db = getDb();
  const result = db.prepare('INSERT INTO attribute_templates (name, unit) VALUES (?, ?)').run(name, unit || '');
  res.status(201).json({ id: result.lastInsertRowid, name, unit });
});

// DELETE /api/settings/attributes/:id
router.delete('/attributes/:id', authMiddleware, requireRole('superadmin', 'admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM attribute_templates WHERE id = ?').run(req.params.id);
  res.json({ message: 'Atributo eliminado' });
});

module.exports = router;
