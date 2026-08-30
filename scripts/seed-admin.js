'use strict';

require('dotenv').config();

const readline = require('readline');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log('\n=== Lucifer License System — Seed Admin ===\n');

  const username = (await question('Admin username: ')).trim();
  if (!username) { console.error('Username cannot be empty.'); process.exit(1); }

  const password = (await question('Admin password: ')).trim();
  if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

  rl.close();

  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    console.error(`Admin "${username}" already exists.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.adminUser.create({ data: { username, passwordHash } });

  console.log(`\n✓ Admin "${admin.username}" created (id: ${admin.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
}).finally(() => prisma.$disconnect());
