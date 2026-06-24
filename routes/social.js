const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', (req, res) => res.json({ posts: [], message: 'Social module active' }));

module.exports = router;
