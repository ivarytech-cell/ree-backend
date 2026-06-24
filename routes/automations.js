// routes/automations.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { status } = req.query;
  const query = status ? 'SELECT * FROM automations WHERE status=? ORDER BY scheduled_at ASC' : 'SELECT * FROM automations ORDER BY scheduled_at ASC';
  res.json(status ? db.prepare(query).all(status) : db.prepare(query).all());
});

router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { client_id, client_name, message, channel, scheduled_at } = req.body;
  if (!message || !scheduled_at) return res.status(400).json({ error: 'Mensaje y fecha requeridos' });
  const r = db.prepare('INSERT INTO automations (client_id, client_name, message, channel, scheduled_at, created_by) VALUES (?,?,?,?,?,?)').run(client_id || null, client_name || '', message, channel || 'whatsapp', scheduled_at, req.user?.name || 'Admin');
  res.json({ id: r.lastInsertRowid, message, scheduled_at });
});

router.put('/:id', authMiddleware, (req, res) => {
  const { message, scheduled_at, status } = req.body;
  getDb().prepare('UPDATE automations SET message=?, scheduled_at=?, status=? WHERE id=?').run(message, scheduled_at, status || 'pending', req.params.id);
  res.json({ success: true });
});

router.delete('/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM automations WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/campaigns', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all());
});

router.post('/campaigns', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, message, target_labels, target_list_id, channel, scheduled_at } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'Nombre y mensaje requeridos' });
  const r = db.prepare('INSERT INTO campaigns (name, message, target_labels, target_list_id, channel, scheduled_at, created_by) VALUES (?,?,?,?,?,?,?)').run(name, message, JSON.stringify(target_labels || []), target_list_id || null, channel || 'whatsapp', scheduled_at || null, req.user?.name || 'Admin');
  res.json({ id: r.lastInsertRowid, name });
});

router.put('/campaigns/:id', authMiddleware, (req, res) => {
  const { name, message, status, scheduled_at } = req.body;
  getDb().prepare('UPDATE campaigns SET name=?, message=?, status=?, scheduled_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, message, status || 'draft', scheduled_at || null, req.params.id);
  res.json({ success: true });
});

router.delete('/campaigns/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/campaigns/:id/send', authMiddleware, (req, res) => {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
  db.prepare("UPDATE campaigns SET status='sent', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaign.id);
  res.json({ success: true, message: 'Campaña marcada como enviada.' });
});

module.exports = router;
