/* eslint-disable no-console */
/**
 * Minimal migration runner (MongoDB has no schema DDL; migrations here create
 * indexes and seed/transform data).
 *
 *   npm run migrate            apply every pending migration, in file-name order
 *   npm run migrate:down       roll back the most recent applied migration
 *   npm run migrate:status     list applied / pending
 *
 * Applied migrations are recorded in the `migrations` collection. Each file in
 * migrations/ exports `up(ctx)` and `down(ctx)`; ctx = { db, log }.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import mongoose from 'mongoose';

import { connectDb, disconnectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const command = process.argv[2] ?? 'up';

async function files() {
  return (await fs.readdir(dir)).filter((f) => /^\d{8}-\d{3}-[\w-]+\.js$/.test(f)).sort();
}

async function load(file) {
  const mod = await import(pathToFileURL(path.join(dir, file)).href);
  if (typeof mod.up !== 'function' || typeof mod.down !== 'function') throw new Error(`${file} must export up() and down()`);
  return mod;
}

export async function runMigrations(cmd = 'up', { quiet = false } = {}) {
  const log = (...a) => !quiet && console.log(...a);
  const col = mongoose.connection.db.collection('migrations');
  await col.createIndex({ name: 1 }, { unique: true });
  const applied = new Set((await col.find().toArray()).map((m) => m.name));
  const all = await files();
  const ctx = { db: mongoose.connection.db, log };

  if (cmd === 'status') {
    for (const f of all) log(`${applied.has(f) ? '✔ applied' : '… pending'}  ${f}`);
    return;
  }
  if (cmd === 'down') {
    const last = await col.find().sort({ appliedAt: -1, name: -1 }).limit(1).next();
    if (!last) return log('Nothing to roll back.');
    log(`↩ ${last.name}`);
    await (await load(last.name)).down(ctx);
    await col.deleteOne({ name: last.name });
    return log('Rolled back.');
  }
  const pending = all.filter((f) => !applied.has(f));
  if (!pending.length) return log('Database is up to date.');
  for (const f of pending) {
    log(`→ ${f}`);
    await (await load(f)).up(ctx);
    await col.insertOne({ name: f, appliedAt: new Date() });
  }
  log(`Applied ${pending.length} migration(s).`);
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await connectDb(env.MONGODB_URI);
    await runMigrations(command);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDb().catch(() => {});
  }
}
