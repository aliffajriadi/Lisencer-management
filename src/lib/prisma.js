'use strict';

const { PrismaClient } = require('@prisma/client');

let prisma;

if (!global._prisma) {
  global._prisma = new PrismaClient({
    datasources: {
      db: { url: process.env.DATABASE_URL || 'file:./dev.db' },
    },
  });
  // Enable WAL mode for better read concurrency under load
  global._prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL').catch(() => {});
  global._prisma.$executeRawUnsafe('PRAGMA synchronous=NORMAL').catch(() => {});
  global._prisma.$executeRawUnsafe('PRAGMA cache_size=10000').catch(() => {});
}

prisma = global._prisma;

module.exports = prisma;
