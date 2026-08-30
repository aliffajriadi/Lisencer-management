'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const { combine, timestamp, json, printf, colorize } = format;

const consoleFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

const logger = createLogger({
  level: 'info',
  format: combine(timestamp(), json()),
  transports: [
    new transports.File({
      filename: path.join(process.cwd(), 'logs', 'app.log'),
      level: 'info',
    }),
    new transports.File({
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
    }),
  ],
});

const auditLogger = createLogger({
  level: 'info',
  format: combine(timestamp(), json()),
  transports: [
    new transports.File({
      filename: path.join(process.cwd(), 'logs', 'audit.log'),
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), consoleFormat),
    })
  );
}

/**
 * Log an admin action to audit trail
 * @param {string} adminUsername
 * @param {string} action  - e.g. 'create_voucher', 'revoke_license'
 * @param {object} details - relevant IDs and data
 */
function auditLog(adminUsername, action, details = {}) {
  auditLogger.info(action, { admin: adminUsername, ...details });
}

/**
 * Log a redeem event (success or failure) from public page
 */
function redeemLog(username, code, success, reason = null) {
  auditLogger.info('redeem', { username, code, success, reason });
}

module.exports = { logger, auditLog, redeemLog };
