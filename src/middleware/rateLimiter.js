'use strict';

const rateLimit = require('express-rate-limit');

// Rate limiter for /api/license/verify
// 30 requests per minute per IP
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: false, reason: 'rate_limited' },
  keyGenerator: (req) => {
    // Combine IP + username to limit per (IP, username) pair
    const user = (req.body && req.body.user) ? req.body.user.toLowerCase().trim() : '';
    return `${req.ip}:${user}`;
  },
});

// Stricter per-username limiter (60 req/min across all IPs for same username)
const verifyUsernameLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: false, reason: 'rate_limited' },
  keyGenerator: (req) => {
    const user = (req.body && req.body.user) ? req.body.user.toLowerCase().trim() : '';
    return `usr:${user}`;
  },
});

module.exports = { verifyLimiter, verifyUsernameLimiter };
