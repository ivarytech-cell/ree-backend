// routes/messaging.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/templates', authMiddleware, (req, res) => {
  const db = getDb();
  const { type, team_id } = req.query;
  let query = 'SELECT t.*, tm.name as team_name FROM message_templates t LEFT JOIN teams tm ON t.team_id=tm.id';
  const params = []; const where = [];
  if (type) { where.push('t.type=?'); params.push(type); }
  if (team_id) { where.push('t.team_id=?'); params.push(team_id); }
  if (where.length) query += ' WHERE ' + where.join(' AND ');
  query += ' ORDER BY t.name';
  res.json(db.prepare(query).all(...params));
});

router.post('/templates', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, type, category, text_content, team_id, variables } = req.body;
  if (!name || !text_content) return res.status(400).json({ error: 'Nombre y texto requeridos' });
  const r = db.prepare('INSERT INTO message_templates (name, type, category, text_content, team_id, variables) VALUES (?,?,?,?,?,?)').run(name, type || 'quick_reply', category || 'MARKETING', text_content, team_id || null, JSON.stringify(variables || []));
  res.json({ id: r.lastInsertRowid, name });
});

router.put('/templates/:id', authMiddleware, (req, res) => {
  const { name, type, category, text_content, team_id, is_active, status } = req.body;
  getDb().prepare('UPDATE message_templates SET name=?, type=?, category=?, text_content=?, team_id=?, is_active=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, type, category, text_content, team_id || null, is_active ? 1 : 0, status || 'approved', req.params.id);
  res.json({ success: true });
});

router.delete('/templates/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM message_templates WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/topics', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM conversation_topics ORDER BY name').all());
});

router.post('/topics', authMiddleware, (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = getDb().prepare('INSERT INTO conversation_topics (name, color) VALUES (?,?)').run(name, color || '#6b7280');
  res.json({ id: r.lastInsertRowid, name, color });
});

router.delete('/topics/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM conversation_topics WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/rules', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM messaging_rules ORDER BY order_index').all());
});

router.post('/rules', authMiddleware, (req, res) => {
  const { name, condition_type, condition_value, action_type, action_value, order_index } = req.body;
  const r = getDb().prepare('INSERT INTO messaging_rules (name, condition_type, condition_value, action_type, action_value, order_index) VALUES (?,?,?,?,?,?)').run(name, condition_type, condition_value, action_type, action_value, order_index || 0);
  res.json({ id: r.lastInsertRowid, name });
});

router.put('/rules/:id', authMiddleware, (req, res) => {
  const { name, condition_type, condition_value, action_type, action_value, is_active, order_index } = req.body;
  getDb().prepare('UPDATE messaging_rules SET name=?, condition_type=?, condition_value=?, action_type=?, action_value=?, is_active=?, order_index=? WHERE id=?').run(name, condition_type, condition_value, action_type, action_value, is_active ? 1 : 0, order_index || 0, req.params.id);
  res.json({ success: true });
});

router.delete('/rules/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM messaging_rules WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/welcome', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM welcome_messages ORDER BY channel').all());
});

router.post('/welcome', authMiddleware, (req, res) => {
  const { channel, message } = req.body;
  getDb().prepare('INSERT OR REPLACE INTO welcome_messages (channel, message) VALUES (?,?)').run(channel, message);
  res.json({ success: true });
});

module.exports = router;
