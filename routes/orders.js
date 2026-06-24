// routes/orders.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.get('/channels', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM sales_channels WHERE is_active=1 ORDER BY name').all());
});
router.post('/channels', authMiddleware, (req, res) => {
  const { name, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const r = getDb().prepare('INSERT INTO sales_channels (name, type) VALUES (?,?)').run(name, type || 'manual');
  res.json({ id: r.lastInsertRowid, name });
});
router.delete('/channels/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM sales_channels WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/taxes', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM taxes WHERE is_active=1 ORDER BY name').all());
});
router.post('/taxes', authMiddleware, (req, res) => {
  const { name, rate } = req.body;
  if (!name || rate === undefined) return res.status(400).json({ error: 'Nombre y tasa requeridos' });
  const r = getDb().prepare('INSERT INTO taxes (name, rate) VALUES (?,?)').run(name, parseFloat(rate));
  res.json({ id: r.lastInsertRowid, name, rate });
});
router.delete('/taxes/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM taxes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/terms/current', authMiddleware, (req, res) => {
  const s = getDb().prepare("SELECT value FROM settings WHERE key='terms_and_conditions'").get();
  res.json({ content: s?.value || '' });
});
router.post('/terms', authMiddleware, (req, res) => {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('terms_and_conditions', ?)").run(req.body.content || '');
  res.json({ success: true });
});

router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { status, payment_status, channel_id, search, from, to } = req.query;
  let query = 'SELECT * FROM orders';
  const params = [];
  const where = [];
  if (status) { where.push('status=?'); params.push(status); }
  if (payment_status) { where.push('payment_status=?'); params.push(payment_status); }
  if (channel_id) { where.push('channel_id=?'); params.push(channel_id); }
  if (search) { where.push('(client_name LIKE ? OR order_number LIKE ? OR client_phone LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  if (where.length) query += ' WHERE ' + where.join(' AND ');
  query += ' ORDER BY created_at DESC';
  res.json(db.prepare(query).all(...params));
});

router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json({ ...order, items: db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id) });
});

router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { client_id, client_name, client_phone, currency, status, payment_status, channel_id, channel_name, vendor_name, notes, discount, items, terms_accepted } = req.body;
  let subtotal = 0, tax_total = 0;
  const processedItems = (items || []).map(item => {
    const s = (item.price || 0) * (item.quantity || 1);
    const t = s * ((item.tax_rate || 0) / 100);
    subtotal += s; tax_total += t;
    return { ...item, subtotal: s };
  });
  const discountAmt = parseFloat(discount || 0);
  const total = subtotal + tax_total - discountAmt;
  const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
  const result = db.prepare(`INSERT INTO orders (order_number, client_id, client_name, client_phone, currency, status, payment_status, channel_id, channel_name, vendor_name, notes, discount, subtotal, tax_total, total, terms_accepted, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderNumber, client_id || null, client_name || '', client_phone || '', currency || 'DOP', status || 'pending', payment_status || 'pending', channel_id || null, channel_name || '', vendor_name || '', notes || '', discountAmt, subtotal, tax_total, total, terms_accepted ? 1 : 0, req.user?.id || null);
  const orderId = result.lastInsertRowid;
  const stmt = db.prepare('INSERT INTO order_items (order_id, product_id, product_name, sku, quantity, price, tax_id, tax_rate, subtotal) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const item of processedItems) stmt.run(orderId, item.product_id || null, item.product_name || '', item.sku || '', item.quantity || 1, item.price || 0, item.tax_id || null, item.tax_rate || 0, item.subtotal);
  res.json({ id: orderId, order_number: orderNumber, total });
});

router.put('/:id', authMiddleware, (req, res) => {
  const { status, payment_status, notes, vendor_name } = req.body;
  getDb().prepare('UPDATE orders SET status=?, payment_status=?, notes=?, vendor_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, payment_status, notes || '', vendor_name || '', req.params.id);
  res.json({ success: true });
});

router.delete('/:id', authMiddleware, (req, res) => {
  getDb().prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
