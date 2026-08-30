'use strict';

const express = require('express');
const router = express.Router();
const { verifyLimiter, verifyUsernameLimiter } = require('../middleware/rateLimiter');
const { verifyLicense } = require('../controllers/apiController');

router.post(
  '/license/verify',
  verifyLimiter,
  verifyUsernameLimiter,
  verifyLicense
);

module.exports = router;
