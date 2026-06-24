// routes/stats.js
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

function dateFilter(from, to) {
  if (from && to) return { clause: 'AND created_at BETWEEN ? AND ?', params: [from, to] };
  if (from) return { clause: 'AND created_at >= ?', params: [from] };
  const d = new Date(); d.setDate(d.getDate() - 30);
  return { clause: 'AND created_at >= ?', params: [d.toISOString().split('T')[0]] };
}

router.get('/overview', authMiddleware, (req, res) => {
  const db = getDb();
  const { clause, params } = dateFilter(req.query.from, req.query.to);
  res.json({
    conversations: {
      total: db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE 1=1 ${clause}`).get(...params)?.n || 0,
      ai_managed: db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE is_ai_managed=1 ${clause}`).get(...params)?.n || 0,
      needs_human: db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE needs_human=1 ${clause}`).get(...params)?.n || 0,
      purchase_intent: db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE has_purchase_intent=1 ${clause}`).get(...params)?.n || 0,
    },
    orders: {
      total: db.prepare(`SELECT COUNT(*) as n FROM orders WHERE 1=1 ${clause}`).get(...params)?.n || 0,
      revenue: db.prepare(`SELECT COALESCE(SUM(total),0) as t FROM orders WHERE status!='cancelled' ${clause}`).get(...params)?.t || 0,
    },
    clients: { total: db.prepare(`SELECT COUNT(*) as n FROM clients WHERE 1=1 ${clause}`).get(...params)?.n || 0 },
  });
});

router.get('/messages', authMiddleware, (req, res) => {
  const db = getDb();
  const { clause, params } = dateFilter(req.query.from, req.query.to);
  res.json({
    by_channel: db.prepare(`SELECT channel, COUNT(*) as count FROM conversations WHERE 1=1 ${clause} GROUP BY channel`).all(...params),
    by_day: db.prepare(`SELECT DATE(created_at) as day, COUNT(*) as count FROM conversations WHERE 1=1 ${clause} GROUP BY day ORDER BY day`).all(...params),
    total_messages: db.prepare(`SELECT COUNT(*) as n FROM messages WHERE 1=1 ${clause.replace(/created_at/g, 'sent_at')}`).get(...params)?.n || 0,
  });
});

router.get('/sales', authMiddleware, (req, res) => {
  const db = getDb();
  const { clause, params } = dateFilter(req.query.from, req.query.to);
  res.json({
    by_status: db.prepare(`SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM orders WHERE 1=1 ${clause} GROUP BY status`).all(...params),
    by_channel: db.prepare(`SELECT channel_name, COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM orders WHERE 1=1 ${clause} GROUP BY channel_name ORDER BY revenue DESC`).all(...params),
    top_products: db.prepare(`SELECT oi.product_name, SUM(oi.quantity) as units, SUM(oi.subtotal) as revenue FROM order_items oi JOIN orders o ON oi.order_id=o.id WHERE o.status!='cancelled' ${clause.replace(/created_at/g, 'o.created_at')} GROUP BY oi.product_name ORDER BY units DESC LIMIT 10`).all(...params),
    by_day: db.prepare(`SELECT DATE(created_at) as day, COUNT(*) as orders, COALESCE(SUM(total),0) as revenue FROM orders WHERE status!='cancelled' ${clause} GROUP BY day ORDER BY day`).all(...params),
  });
});

router.get('/agents', authMiddleware, (req, res) => {
  const db = getDb();
  const { params } = dateFilter(req.query.from, req.query.to);
  res.json({
    agent_stats: db.prepare(`SELECT a.id, a.name, a.last_name, a.status, COUNT(c.id) as total_conversations, SUM(CASE WHEN c.status='open' THEN 1 ELSE 0 END) as open_conversations FROM agents a LEFT JOIN conversations c ON a.id=c.assigned_agent_id AND c.created_at >= ? GROUP BY a.id ORDER BY total_conversations DESC`).all(params[0]),
  });
});

router.get('/ai', authMiddleware, (req, res) => {
  const db = getDb();
  const { clause, params } = dateFilter(req.query.from, req.query.to);
  const total = db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE 1=1 ${clause}`).get(...params)?.n || 0;
  const ai_handled = db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE is_ai_managed=1 ${clause}`).get(...params)?.n || 0;
  const escalated = db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE needs_human=1 ${clause}`).get(...params)?.n || 0;
  const intent = db.prepare(`SELECT COUNT(*) as n FROM conversations WHERE has_purchase_intent=1 ${clause}`).get(...params)?.n || 0;
  res.json({
    total_conversations: total, ai_handled, purchase_intent: intent,
    escalation_rate: total > 0 ? Math.round((escalated / total) * 100) : 0,
    resolution_rate: ai_handled > 0 ? Math.round(((ai_handled - escalated) / ai_handled) * 100) : 0,
    by_day: db.prepare(`SELECT DATE(created_at) as day, SUM(is_ai_managed) as ai_handled, COUNT(*) as total FROM conversations WHERE 1=1 ${clause} GROUP BY day ORDER BY day`).all(...params),
  });
});

router.get('/campaigns', authMiddleware, (req, res) => {
  res.json({ campaigns: getDb().prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all() });
});

module.exports = router;
