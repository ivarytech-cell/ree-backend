require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db/database');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

getDb();

app.use('/api/auth',         require('./routes/auth'));
app.use('/api/users',        require('./routes/users'));
app.use('/api/products',     require('./routes/products'));
app.use('/api/categories',   require('./routes/categories'));
app.use('/api/brands',       require('./routes/brands'));
app.use('/api/settings',     require('./routes/settings'));
app.use('/api/wordpress',    require('./routes/wordpress'));
app.use('/api/woocommerce',  require('./routes/wordpress'));
app.use('/api/ai',           require('./routes/ai'));
app.use('/api/rubenai',      require('./routes/rubenai'));
app.use('/api/social',       require('./routes/social'));
app.use('/api/merkalectro',  require('./routes/merkalectro'));
app.use('/api/clients',      require('./routes/clients'));
app.use('/api/orders',       require('./routes/orders'));
app.use('/api/inbox',        require('./routes/inbox'));
app.use('/api/agents',       require('./routes/agents'));
app.use('/api/automations',  require('./routes/automations'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api/messaging',    require('./routes/messaging'));
app.use('/api/stats',        require('./routes/stats'));
app.use('/api/commerce',     require('./routes/commerce'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Error interno' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Backend corriendo en puerto ${PORT}`));
module.exports = app;
