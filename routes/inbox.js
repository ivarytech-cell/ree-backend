// routes/inbox.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/conversations', authMiddleware, (req, res) => {
  const db = getDb();
  const { status, channel, assigned_agent_id, filter } = req.query;
  let query = 'SELECT * FROM conversations';
  const params = [];
  const where = [];
  if (status) { where.push('status=?'); params.push(status); }
  if (channel) { where.push('channel=?'); params.push(channel); }
  if (assigned_agent_id) { where.push('assigned_agent_id=?'); params.push(assigned_agent_id); }
  if (filter === 'unassigned') where.push('assigned_agent_id IS NULL AND is_ai_managed=0');
  if (filter === 'ai') where.push('is_ai_managed=1');
  if (filter === 'intent') where.push('has_purchase_intent=1');
  if (filter === 'needs_human') where.push('needs_human=1');
  if (where.length) query += ' WHERE ' + where.join(' AND ');
  query += ' ORDER BY last_message_at DESC';
  res.json(db.prepare(query).all(...params));
});

router.get('/conversations/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY sent_at').all(conv.id);
  db.prepare('UPDATE conversations SET unread_count=0 WHERE id=?').run(conv.id);
  db.prepare('UPDATE messages SET is_read=1 WHERE conversation_id=?').run(conv.id);
  res.json({ ...conv, messages: msgs });
});

router.post('/conversations', authMiddleware, (req, res) => {
  const db = getDb();
  const { client_id, client_name, client_phone, channel } = req.body;
  const r = db.prepare('INSERT INTO conversations (client_id, client_name, client_phone, channel) VALUES (?,?,?,?)').run(client_id || null, client_name || '', client_phone || '', channel || 'whatsapp');
  res.json({ id: r.lastInsertRowid });
});

router.put('/conversations/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const { status, assigned_agent_id, is_ai_managed, has_purchase_intent, needs_human } = req.body;
  const fields = []; const params = [];
  if (status !== undefined) { fields.push('status=?'); params.push(status); }
  if (assigned_agent_id !== undefined) { fields.push('assigned_agent_id=?'); params.push(assigned_agent_id); }
  if (is_ai_managed !== undefined) { fields.push('is_ai_managed=?'); params.push(is_ai_managed ? 1 : 0); }
  if (has_purchase_intent !== undefined) { fields.push('has_purchase_intent=?'); params.push(has_purchase_intent ? 1 : 0); }
  if (needs_human !== undefined) { fields.push('needs_human=?'); params.push(needs_human ? 1 : 0); }
  if (!fields.length) return res.json({ success: true });
  fields.push('updated_at=CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE conversations SET ${fields.join(',')} WHERE id=?`).run(...params);
  res.json({ success: true });
});

router.post('/conversations/:id/messages', authMiddleware, (req, res) => {
  const db = getDb();
  const { content, sender_type, sender_name, message_type } = req.body;
  if (!content) return res.status(400).json({ error: 'Contenido requerido' });
  const r = db.prepare('INSERT INTO messages (conversation_id, sender_type, sender_name, content, message_type) VALUES (?,?,?,?,?)').run(req.params.id, sender_type || 'agent', sender_name || 'Agente', content, message_type || 'text');
  db.prepare('UPDATE conversations SET last_message=?, last_message_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(content.substring(0, 100), req.params.id);
  res.json({ id: r.lastInsertRowid, content, sender_type });
});

router.get('/stats', authMiddleware, (req, res) => {
  const db = getDb();
  res.json({
    total: db.prepare('SELECT COUNT(*) as n FROM conversations').get().n,
    open: db.prepare("SELECT COUNT(*) as n FROM conversations WHERE status='open'").get().n,
    unassigned: db.prepare('SELECT COUNT(*) as n FROM conversations WHERE assigned_agent_id IS NULL AND is_ai_managed=0').get().n,
    ai_managed: db.prepare('SELECT COUNT(*) as n FROM conversations WHERE is_ai_managed=1').get().n,
    needs_human: db.prepare('SELECT COUNT(*) as n FROM conversations WHERE needs_human=1').get().n,
    intent: db.prepare('SELECT COUNT(*) as n FROM conversations WHERE has_purchase_intent=1').get().n,
  });
});

module.exports = router;
