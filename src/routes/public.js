'use strict';

const express = require('express');
const router = express.Router();
const { checkGet, checkPost, redeemGet, redeemPost } = require('../controllers/publicController');
const manageRoutes = require('./manage');

router.get('/', (req, res) => res.redirect('/check'));
router.get('/check', checkGet);
router.post('/check', checkPost);
router.get('/redeem', redeemGet);
router.post('/redeem', redeemPost);
router.use('/manage', manageRoutes);

module.exports = router;
