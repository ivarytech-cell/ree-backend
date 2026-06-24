// routes/clients.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { search, label, channel } = req.query;
  let query = `SELECT c.*, GROUP_CONCAT(cl.name) as label_names, GROUP_CONCAT(cl.color) as label_colors, GROUP_CONCAT(cl.id) as label_ids
    FROM clients c LEFT JOIN client_label_assignments cla ON c.id = cla.client_id LEFT JOIN client_labels cl ON cla.label_id = cl.id`;
  const params = [];
  const where = [];
  if (search) { where.push("(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (channel) { where.push("c.channel=?"); params.push(channel); }
  if (where.length) query += ' WHERE ' + where.join(' AND ');
  query += ' GROUP BY c.id ORDER BY c.created_at DESC';
  let clients = db.prepare(query).all(...params);
  if (label) clients = clients.filter(c => c.label_ids && c.label_ids.split(',').includes(String(label)));
  clients = clients.map(c => ({
    ...c,
    labels: c.label_ids ? c.label_ids.split(',').map((id, i) => ({ id: parseInt(id), name: c.label_names?.split(',')[i] || '', color: c.label_colors?.split(',')[i] || '#3b82f6' })) : []
  }));
  res.json(clients);
});

router.get('/labels/all', authMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM client_labels ORDER BY name').all());
});

router.get('/lists/all', authMiddleware, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT cl.*, COUNT(clm.client_id) as member_count FROM client_lists cl LEFT JOIN client_list_members clm ON cl.id = clm.list_id GROUP BY cl.id ORDER BY cl.created_at DESC').all());
});

router.get('/calendar/events', authMiddleware, (req, res) => {
  const db = getDb();
  const { month, year } = req.query;
  if (month && year) {
    res.json(db.prepare("SELECT * FROM calendar_events WHERE strftime('%Y', event_date)=? AND strftime('%m', event_date)=? ORDER BY event_date").all(String(year), String(month).padStart(2, '0')));
  } else {
    res.json(db.prepare('SELECT * FROM calendar_events ORDER BY event_date').all());
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const labels = db.prepare('SELECT cl.* FROM client_labels cl JOIN client_label_assignments cla ON cl.id = cla.label_id WHERE cla.client_id=?').all(client.id);
  const orders = db.prepare('SELECT id, order_number, total, status, created_at FROM orders WHERE client_id=? ORDER BY created_at DESC LIMIT 10').all(client.id);
  res.json({ ...client, labels, orders });
});

router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, last_name, phone, email, channel, notes, label_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const result = db.prepare('INSERT INTO clients (name, last_name, phone, email, channel, notes, created_by) VALUES (?,?,?,?,?,?,?)').run(name, last_name || '', phone || '', email || '', channel || 'manual', notes || '', req.user?.id || null);
  const clientId = result.lastInsertRowid;
  if (Array.isArray(label_ids)) {
    const stmt = db.prepare('INSERT OR IGNORE INTO client_label_assignments (client_id, label_id) VALUES (?,?)');
    label_ids.forEach(lid => stmt.run(clientId, lid));
  }
  res.json({ id: clientId, name, phone });
});

router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, last_name, phone, email, channel, notes, label_ids } = req.body;
  db.prepare('UPDATE clients SET name=?, last_name=?, phone=?, email=?, channel=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, last_name || '', phone || '', email || '', channel || 'manual', notes || '', req.params.id);
  if (label_ids !== undefined) {
    db.prepare('DELETE FROM client_label_assignments WHERE client_id=?').run(req.params.id);
    if (Array.isArray(label_ids)) {
      const stmt = db.prepare('INSERT OR IGNORE INTO client_label_assignments (client_id, label_id) VALUES (?,?)');
      label_ids.forEach(lid => stmt.run(req.params.id, lid));
    }
  }
  res.json({ success: true });
});

router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/labels', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare('INSERT INTO client_labels (name, color) VALUES (?,?)').run(name, color || '#3b82f6');
  res.json({ id: r.lastInsertRowid, name, color });
});

router.delete('/labels/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM client_labels WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/lists', authMiddleware, (req, res) => {
  const db = getDb();
  const { name, client_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare('INSERT INTO client_lists (name, created_by) VALUES (?,?)').run(name, req.user?.name || 'Admin');
  if (Array.isArray(client_ids)) {
    const stmt = db.prepare('INSERT OR IGNORE INTO client_list_members (list_id, client_id) VALUES (?,?)');
    client_ids.forEach(cid => stmt.run(r.lastInsertRowid, cid));
  }
  res.json({ id: r.lastInsertRowid, name });
});

router.delete('/lists/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM client_lists WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/calendar/events', authMiddleware, (req, res) => {
  const db = getDb();
  const { title, event_date, description, auto_message } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'Título y fecha requeridos' });
  const r = db.prepare('INSERT INTO calendar_events (title, event_date, description, auto_message) VALUES (?,?,?,?)').run(title, event_date, description || '', auto_message || '');
  res.json({ id: r.lastInsertRowid, title, event_date });
});

router.delete('/calendar/events/:id', authMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM calendar_events WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.post('/import', authMiddleware, (req, res) => {
  const db = getDb();
  const { clients: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No hay datos para importar' });
  const stmt = db.prepare('INSERT INTO clients (name, last_name, phone, email, channel, notes) VALUES (?,?,?,?,?,?)');
  let imported = 0, errors = 0;
  for (const row of rows) {
    try { if (!row.name && !row.phone) { errors++; continue; } stmt.run(row.name || '', row.last_name || '', row.phone || '', row.email || '', row.channel || 'manual', row.notes || ''); imported++; } catch { errors++; }
  }
  res.json({ imported, errors, total: rows.length });
});

module.exports = router;
