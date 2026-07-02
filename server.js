require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ruta de salud primero, para comprobar que Railway sí prendió
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.1-v61-crm-marketing-ux-ai',
    message: 'REE backend funcionando con CRM UX y Marketing IA conectado',
  });
});


// Diagnóstico público para confirmar que el deploy v58 está activo sin token
app.get('/api/product-governance/ping', (req, res) => {
  res.json({
    ok: true,
    module: 'product-governance',
    version: 'v61',
    message: 'Ruta pública de diagnóstico activa con backend v61',
    timestamp: new Date().toISOString(),
  });
});


// Seguridad fuerte: un usuario técnico NO puede consumir APIs internas aunque escriba rutas manualmente.
function technicianApiGuard(req, res, next) {
  try {
    if (!req.path.startsWith('/api/')) return next();

    const publicExact = new Set(['/api/health', '/api/product-governance/ping']);
    const allowedPrefixes = [
      '/api/auth',
      '/api/product-governance/technician',
    ];

    if (publicExact.has(req.path) || allowedPrefixes.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }

    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const token = String(authHeader).startsWith('Bearer ') ? String(authHeader).slice(7) : '';
    if (!token) return next();

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const role = String(decoded?.role || '').toLowerCase();
    if (['tecnico', 'técnico', 'technician'].includes(role)) {
      return res.status(403).json({
        error: 'Acceso limitado: los técnicos solo pueden usar el catálogo técnico y sus pedidos.',
      });
    }
  } catch (error) {
    // Si el token está vencido o inválido, dejamos que el middleware de cada ruta responda 401.
  }
  return next();
}

app.use(technicianApiGuard);

// Inicializar base de datos sin tumbar el servidor completo
try {
  const { getDb } = require('./db/database');
  getDb();
  console.log('✅ Base de datos inicializada');
} catch (error) {
  console.error('❌ Error inicializando base de datos:', error.message);
}

// Cargar rutas de forma segura
function safeRoute(routePath, filePath) {
  try {
    app.use(routePath, require(filePath));
    console.log(`✅ Ruta cargada: ${routePath}`);
  } catch (error) {
    console.error(`❌ Error cargando ruta ${routePath}:`, error.message);
  }
}

safeRoute('/api/auth', './routes/auth');
safeRoute('/api/users', './routes/users');
safeRoute('/api/products', './routes/products');
safeRoute('/api/product-governance', './routes/product-governance');
safeRoute('/api/crm-marketing', './routes/crm-marketing');
safeRoute('/api/categories', './routes/categories');
safeRoute('/api/brands', './routes/brands');
safeRoute('/api/settings', './routes/settings');
safeRoute('/api/wordpress', './routes/wordpress');
safeRoute('/api/woocommerce', './routes/wordpress');
safeRoute('/api/ai', './routes/ai');
safeRoute('/api/rubenai', './routes/rubenai');
safeRoute('/api/social', './routes/social');
safeRoute('/api/merkalectro', './routes/merkalectro');
safeRoute('/api/clients', './routes/clients');
safeRoute('/api/orders', './routes/orders');
safeRoute('/api/inbox', './routes/inbox');
safeRoute('/api/agents', './routes/agents');
safeRoute('/api/automations', './routes/automations');
safeRoute('/api/integrations', './routes/integrations');
safeRoute('/api/messaging', './routes/messaging');
safeRoute('/api/whatsapp', './routes/whatsapp');
safeRoute('/api/stats', './routes/stats');
safeRoute('/api/commerce', './routes/commerce');

app.use((err, req, res, next) => {
  console.error('❌ Error general:', err);
  res.status(500).json({ error: err.message || 'Error interno' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend corriendo en puerto ${PORT}`);
});

module.exports = app;
