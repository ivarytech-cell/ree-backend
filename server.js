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
    version: '2.0.0',
    message: 'REE backend funcionando',
  });
});

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
