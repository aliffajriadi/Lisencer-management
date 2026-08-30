'use strict';

require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATABASE_URL: process.env.DATABASE_URL || 'file:./dev.db',
  SESSION_SECRET: process.env.SESSION_SECRET || 'change-me-in-production',
  NODE_ENV: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
};
