'use strict';

const prisma = require('../lib/prisma');
const { logger } = require('../lib/logger');
const cache = require('../lib/verifyCache');

/**
 * POST /api/license/verify
 * Called by checkWhitelist() in loader.lua
 */
async function verifyLicense(req, res) {
  try {
    const { user, sc } = req.body;

    if (!user || !sc || typeof user !== 'string' || typeof sc !== 'string') {
      return res.status(400).json({ valid: false, reason: 'invalid_request' });
    }

    const username = user.trim().toLowerCase();
    const scriptCode = sc.trim().toUpperCase();

    // ── Cache hit ────────────────────────────────────────────────────────────
    const cached = cache.get(username, scriptCode);
    if (cached !== null) {
      // Perbarui daysLeft secara dinamis dari expiresAt yang tersimpan
      if (cached.valid && cached._expiresAt) {
        const now = new Date();
        const daysLeft = Math.ceil((new Date(cached._expiresAt) - now) / (1000 * 60 * 60 * 24));
        if (daysLeft <= 0) {
          // Expired sejak di-cache — invalidasi dan lanjut ke DB
          cache.invalidate(username, scriptCode);
        } else {
          return res.json({ valid: true, expiresAt: cached._expiresAt, daysLeft });
        }
      } else {
        return res.json(cached);
      }
    }

    // ── DB query ─────────────────────────────────────────────────────────────
    const license = await prisma.license.findFirst({
      where: {
        username,
        scriptType: { code: scriptCode },
      },
      include: { scriptType: true },
    });

    let response;

    if (!license) {
      response = { valid: false, reason: 'not_found' };
      logger.info('verify: not_found', { username, scriptCode, ip: req.ip });
      cache.set(username, scriptCode, response);
      return res.json(response);
    }

    if (license.revoked) {
      response = { valid: false, reason: 'revoked' };
      logger.info('verify: revoked', { username, scriptCode, ip: req.ip });
      cache.set(username, scriptCode, response);
      return res.json(response);
    }

    const now = new Date();
    if (license.expiresAt <= now) {
      response = { valid: false, reason: 'expired' };
      logger.info('verify: expired', { username, scriptCode, ip: req.ip });
      cache.set(username, scriptCode, response);
      return res.json(response);
    }

    const daysLeft = Math.ceil((license.expiresAt - now) / (1000 * 60 * 60 * 24));
    const expiresAtIso = license.expiresAt.toISOString();

    response = {
      valid: true,
      expiresAt: expiresAtIso,
      daysLeft,
      // _expiresAt disimpan di cache untuk recalculate daysLeft, tidak dikirim ke client
      _expiresAt: expiresAtIso,
    };

    logger.info('verify: valid', { username, scriptCode, ip: req.ip, daysLeft });
    cache.set(username, scriptCode, response);

    // Jangan kirim _expiresAt ke client
    return res.json({ valid: true, expiresAt: expiresAtIso, daysLeft });

  } catch (err) {
    logger.error('verify: server error', { error: err.message });
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
}

module.exports = { verifyLicense };
