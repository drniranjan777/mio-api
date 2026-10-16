import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';

import './helpers.js'; // test env vars
import { createLimiters } from '../src/middlewares/rateLimits.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Just enough Redis for rate-limit-redis (SCRIPT LOAD + EVALSHA of its two Lua
 * scripts), one keyspace shared by every "connection" — like separate workers
 * talking to one Redis server.
 */
class FakeRedis {
  static data = new Map();
  scripts = new Map();
  async call(cmd, ...args) {
    if (cmd === 'SCRIPT') {
      const sha = crypto.createHash('sha1').update(args[1]).digest('hex');
      this.scripts.set(sha, args[1].includes('INCR') ? 'incr' : 'get');
      return sha;
    }
    assert.equal(cmd, 'EVALSHA');
    const [sha, , key, , windowMs] = args;
    const kind = this.scripts.get(sha);
    if (!kind) throw new Error('NOSCRIPT');
    const now = Date.now();
    let e = FakeRedis.data.get(key);
    if (e && e.expires <= now) e = undefined;
    if (kind === 'get') return e ? [String(e.hits), e.expires - now] : [false, -2];
    if (!e) FakeRedis.data.set(key, (e = { hits: 0, expires: now + Number(windowMs) }));
    e.hits += 1;
    return [e.hits, e.expires - now];
  }
}

/** One "worker": its own limiter instances + app, sharing only the store. */
function worker(redis, prefix = 'test:') {
  const { loginLimiter, authLimiter } = createLimiters({ redis, enabled: true, prefix });
  const app = express();
  app.post('/login', loginLimiter, (_req, res) => res.json({ ok: true }));
  app.post('/otp', authLimiter, (_req, res) => res.json({ ok: true }));
  return () => request(app);
}

describe('rate limits across workers', () => {
  it('in-memory store: each process counts on its own (why cluster mode needs Redis)', async () => {
    const a = worker(null);
    const b = worker(null);
    for (let i = 0; i < 10; i++) await a().post('/login').expect(200);
    await a().post('/login').expect(429);
    await b().post('/login').expect(200);
  });

  it('shared store: the limit is enforced over all workers together', async () => {
    const a = worker(new FakeRedis());
    const b = worker(new FakeRedis());
    for (let i = 0; i < 5; i++) {
      await a().post('/login').expect(200);
      await b().post('/login').expect(200);
    }
    const res = await b().post('/login').expect(429);
    assert.equal(res.body.error.code, 'RATE_LIMITED');
    await a().post('/login').expect(429);
    // Separate limiters keep separate counters.
    await a().post('/otp').expect(200);
  });

  it('store failure lets requests through instead of failing them', async (t) => {
    const broken = { call: async () => { throw new Error('ECONNREFUSED'); } };
    // express-rate-limit logs each pass-through.
    t.mock.method(console, 'error', () => {});
    await worker(broken)().post('/login').expect(200);
  });
});

/**
 * The real thing: two separate Node processes on one Redis server. Uses
 * TEST_REDIS_URL (default redis://127.0.0.1:6379) and is skipped when no Redis
 * is reachable. Keys go under a random prefix and are deleted afterwards.
 */
describe('rate limits across worker processes (real Redis)', async () => {
  const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1_000, retryStrategy: () => null });
  probe.on('error', () => {});
  const reachable = await probe.connect().then(() => probe.ping()).then(() => true, () => false);
  const prefix = `mio-test:${crypto.randomUUID()}:`;
  const children = [];

  const spawnWorker = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(here, 'fixtures/limiter-worker.js')], {
        env: { ...process.env, TEST_REDIS_URL: url, TEST_RL_PREFIX: prefix, REDIS_URL: '' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      children.push(child);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`worker exited (${code})`)));
      child.stdout.once('data', (d) => resolve(`http://127.0.0.1:${String(d).trim()}`));
    });

  after(async () => {
    for (const c of children) c.kill();
    if (reachable) {
      const keys = await probe.keys(`${prefix}*`);
      if (keys.length) await probe.del(...keys);
    }
    probe.disconnect();
  });

  it('10 logins spread over two processes use up one shared budget', { skip: !reachable && `no Redis at ${url}` }, async () => {
    const [a, b] = await Promise.all([spawnWorker(), spawnWorker()]);
    const pids = new Set();
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${i % 2 ? b : a}/login`, { method: 'POST' });
      assert.equal(res.status, 200);
      pids.add((await res.json()).pid);
    }
    assert.equal(pids.size, 2, 'both processes served requests');
    assert.equal((await fetch(`${a}/login`, { method: 'POST' })).status, 429);
    assert.equal((await fetch(`${b}/login`, { method: 'POST' })).status, 429);
    // The general API limiter has its own counter (and the standard headers).
    const api = await fetch(`${a}/api`);
    assert.equal(api.status, 200);
    assert.match(api.headers.get('ratelimit') ?? '', /limit=300, remaining=299/);
  });
});

describe('cluster-mode configuration', () => {
  const root = path.resolve(here, '..');
  const load = (extra) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://127.0.0.1/x',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        OTP_PEPPER: 'y'.repeat(20),
        PAYMENTS_ENABLED: 'false',
        ...extra,
      },
    });
    return { ok: r.status === 0, stderr: r.stderr };
  };

  it('refuses PM2 cluster mode in production without REDIS_URL', () => {
    const r = load({ exec_mode: 'cluster_mode', instances: '4' });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /REDIS_URL: Cluster mode needs REDIS_URL/);
  });

  it('accepts cluster mode with REDIS_URL, and a single process without it', () => {
    assert.equal(load({ exec_mode: 'cluster_mode', instances: '4', REDIS_URL: 'redis://127.0.0.1:6379/0' }).ok, true);
    assert.equal(load({ exec_mode: 'fork_mode', instances: '1' }).ok, true);
    assert.equal(load({ REDIS_URL: '' }).ok, true);
  });

  it('rejects a REDIS_URL that is not a redis:// URL', () => {
    assert.match(load({ REDIS_URL: 'localhost:6379' }).stderr, /REDIS_URL must start with redis:\/\//);
  });
});
