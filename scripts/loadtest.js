/* eslint-disable no-console */
/**
 * API load test — self-contained and repeatable:
 *   1. in-memory MongoDB (nothing touches your dev or production data)
 *   2. the real API (`src/server.js`) in its own process — or N worker processes
 *      on one port (`--workers N`, like PM2 cluster mode) — rate limits off
 *   3. test accounts created through the public OTP flow (dev-mode PINs)
 *   4. autocannon against the busiest read endpoints, then a mixed booking run
 *
 *   npm run loadtest                       # 20 s per scenario, 50 connections
 *   LOADTEST_DURATION=60 LOADTEST_CONNECTIONS=200 npm run loadtest
 *   npm run loadtest -- --workers 4        # or --workers max (one per CPU), LOADTEST_WORKERS=4
 *
 * Fails (exit 1) when a scenario has errors/non-2xx above 1 % or p99 above
 * LOADTEST_P99_MS (default 800 ms). Results also go to loadtest-report.json.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import autocannon from 'autocannon';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DURATION = Number(process.env.LOADTEST_DURATION ?? 20);
const CONNECTIONS = Number(process.env.LOADTEST_CONNECTIONS ?? 50);
const P99_LIMIT = Number(process.env.LOADTEST_P99_MS ?? 800);
const DOCTORS = Number(process.env.LOADTEST_DOCTORS ?? 40);
const workersArg = process.argv.find((_a, i) => process.argv[i - 1] === '--workers') ?? process.argv.find((a) => a.startsWith('--workers='))?.slice(10);
const WORKERS_RAW = workersArg ?? process.env.LOADTEST_WORKERS ?? '1';
const WORKERS = WORKERS_RAW === 'max' ? os.cpus().length : Math.max(1, Number(WORKERS_RAW) || 1);
const PORT = 4000 + crypto.randomInt(200, 900);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body, token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json?.data;
}

let mobileSeq = 0;
const nextMobile = () => `9${String(700000000 + mobileSeq++).padStart(9, '0')}`;

async function signUp(role) {
  const mobile = nextMobile();
  const { devOtp } = await call('POST', '/auth/otp/request', { mobile, role });
  const { tokens, user } = await call('POST', '/auth/otp/verify', { mobile, role, otp: devOtp });
  return { token: tokens.accessToken, id: user.id, mobile };
}

const SPECIALTIES = ['Cardiology', 'Neurology', 'Dermatology', 'Diabetology', 'Orthopedics'];
const CITIES = [
  ['Hyderabad', 'Telangana'],
  ['Bengaluru', 'Karnataka'],
  ['Chennai', 'Tamil Nadu'],
  ['Mumbai', 'Maharashtra'],
];

async function registeredDoctor(i) {
  const d = await signUp('doctor');
  const [city, state] = CITIES[i % CITIES.length];
  await call(
    'PUT',
    '/doctors/me/profile',
    {
      name: `Dr. Load ${i}`,
      qualification: 'MBBS, MD',
      gender: i % 2 ? 'female' : 'male',
      age: 30 + (i % 30),
      maritalStatus: 'Married',
      specialty: SPECIALTIES[i % SPECIALTIES.length],
      email: `load${i}@example.com`,
      religion: 'Prefer not to Share',
      councilRegNo: `REG${1000 + i}`,
      practice: {
        type: ['hospital', 'clinic', 'both'][i % 3],
        clinicName: `Clinic ${i}`,
        preferredPlace: 'Clinic',
        address: `${i} Main Road`,
        city,
        state,
        hometown: city,
        pincode: '500034',
        locationType: i % 2 ? 'Metro' : 'Non-Metro',
        territoryClass: 'Within City',
      },
    },
    d.token,
  );
  await call(
    'PUT',
    '/doctors/me/final',
    { mrCall: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], from: '00:00', to: '23:55', maxPerDay: 100, companyTypes: ['all'] } },
    d.token,
  );
  return d;
}

async function startApi(mongoUri) {
  const uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'mio-loadtest-uploads-'));
  const clustered = WORKERS > 1;
  const child = spawn(process.execPath, [clustered ? 'scripts/lib/cluster-primary.js' : 'src/server.js'], {
    cwd: root,
    stdio: ['ignore', clustered ? 'pipe' : 'ignore', 'inherit'],
    env: {
      ...process.env,
      API_WORKERS: String(WORKERS),
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      MONGODB_URI: mongoUri,
      JWT_ACCESS_SECRET: crypto.randomBytes(48).toString('hex'),
      JWT_ACCESS_TTL: '2h',
      OTP_PEPPER: crypto.randomBytes(24).toString('hex'),
      OTP_DEV_MODE: 'true',
      OTP_RESEND_SECONDS: '0',
      RATE_LIMITS_ENABLED: 'false',
      LOG_LEVEL: 'warn',
      UPLOADS_DIR: uploads,
    },
  });
  let ready = !clustered;
  if (clustered) {
    let out = '';
    child.stdout.on('data', (d) => {
      if (!ready && (out += d).includes('CLUSTER_READY')) ready = true;
    });
  }
  for (let i = 0; i < 100; i++) {
    if (!ready) {
      await sleep(200);
      continue;
    }
    try {
      if ((await fetch(`${BASE}/health`)).ok) return { child, uploads };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  child.kill();
  throw new Error('API did not start');
}

function run(name, opts) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      { url: `${BASE}${opts.path ?? ''}`, connections: CONNECTIONS, duration: DURATION, ...opts, path: undefined },
      (err, result) => (err ? reject(err) : resolve({ name, result })),
    );
    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

function summarise({ name, result }) {
  const total = result.requests.total || 1;
  const bad = result.errors + result.timeouts + result.non2xx;
  return {
    scenario: name,
    'req/s (avg)': Math.round(result.requests.average),
    requests: result.requests.total,
    'p50 ms': result.latency.p50,
    'p90 ms': result.latency.p90,
    'p99 ms': result.latency.p99,
    'max ms': result.latency.max,
    'error %': Number(((bad / total) * 100).toFixed(2)),
  };
}

async function main() {
  console.log(`Load test: ${WORKERS} API worker(s), ${CONNECTIONS} connections × ${DURATION}s per scenario, ${DOCTORS} doctors`);
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri('mio_loadtest');
  // The catalogue/migration modules read the API config on import.
  Object.assign(process.env, {
    NODE_ENV: 'development',
    MONGODB_URI: uri,
    JWT_ACCESS_SECRET: crypto.randomBytes(48).toString('hex'),
    OTP_PEPPER: crypto.randomBytes(24).toString('hex'),
    LOG_LEVEL: 'warn',
  });

  // Catalogue (plans, FAQs, pages) + migrations, as on a real server.
  await mongoose.connect(uri);
  const { seedCatalog } = await import('./catalog.js');
  await seedCatalog();
  const { runMigrations } = await import('./migrate.js');
  await runMigrations('up', { quiet: true });
  await mongoose.disconnect();

  const { child, uploads } = await startApi(uri);
  try {
    const doctors = [];
    for (let i = 0; i < DOCTORS; i++) doctors.push(await registeredDoctor(i));
    const mr = await signUp('mr');
    await call('POST', '/subscriptions/claim-free', { planCode: 'mr-free-2-months' }, mr.token);
    for (const d of doctors.slice(0, 10)) await call('PUT', `/mrs/me/mcl/${d.id}`, undefined, mr.token);
    const mrAuth = { authorization: `Bearer ${mr.token}` };
    const docAuth = { authorization: `Bearer ${doctors[0].token}` };
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const scenarios = [
      ['GET /health', { path: '/health' }],
      ['GET /me (MR)', { path: '/me', headers: mrAuth }],
      ['GET /doctors — Master MCL (MR)', { path: '/doctors?limit=20', headers: mrAuth }],
      ['GET /doctors?q= search (MR)', { path: '/doctors?q=Load&specialty=Cardiology', headers: mrAuth }],
      ['GET /mrs/me/mcl (MR)', { path: '/mrs/me/mcl', headers: mrAuth }],
      ['GET /doctors/:id/slots (MR)', { path: `/doctors/${doctors[1].id}/slots?date=${tomorrow}`, headers: mrAuth }],
      ['GET /doctors/me/banners (doctor)', { path: '/doctors/me/banners', headers: docAuth }],
      ['GET /appointments (doctor)', { path: '/appointments?limit=50', headers: docAuth }],
      ['GET /reports/summary (MR)', { path: '/reports/summary', headers: mrAuth }],
      ['GET /plans (MR)', { path: '/plans', headers: mrAuth }],
    ];

    const rows = [];
    for (const [name, opts] of scenarios) {
      process.stdout.write(`→ ${name} … `);
      const s = summarise(await run(name, opts));
      rows.push(s);
      console.log(`${s['req/s (avg)']} req/s, p99 ${s['p99 ms']} ms, errors ${s['error %']} %`);
    }

    // Writes: every MR books a different slot of a different doctor. 409 (slot
    // taken) is the correct answer once a slot is gone, so only 5xx count as errors.
    let n = 0;
    const booking = await new Promise((resolve, reject) => {
      const inst = autocannon(
        {
          url: `${BASE}/appointments`,
          connections: Math.min(CONNECTIONS, 20),
          duration: Math.min(DURATION, 15),
          method: 'POST',
          headers: { ...mrAuth, 'content-type': 'application/json' },
          setupClient: (client) =>
            client.setBody(
              JSON.stringify({
                doctorId: doctors[n % doctors.length].id,
                startAt: new Date(Date.UTC(2030, 0, 1 + (Math.floor(n++ / doctors.length) % 300), 4, 30)).toISOString(),
              }),
            ),
        },
        (err, result) => (err ? reject(err) : resolve(result)),
      );
      autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
    });
    const serverErrors = booking['5xx'] ?? 0;
    rows.push({
      scenario: 'POST /appointments (MR booking, writes)',
      'req/s (avg)': Math.round(booking.requests.average),
      requests: booking.requests.total,
      'p50 ms': booking.latency.p50,
      'p90 ms': booking.latency.p90,
      'p99 ms': booking.latency.p99,
      'max ms': booking.latency.max,
      'error %': Number((((booking.errors + booking.timeouts + serverErrors) / (booking.requests.total || 1)) * 100).toFixed(2)),
    });

    console.table(rows);
    const report = { at: new Date().toISOString(), workers: WORKERS, connections: CONNECTIONS, durationSeconds: DURATION, doctors: DOCTORS, node: process.version, cpus: os.cpus().length, rows };
    await fs.writeFile(path.join(root, 'loadtest-report.json'), `${JSON.stringify(report, null, 2)}\n`);

    const failed = rows.filter((r) => r['error %'] > 1 || r['p99 ms'] > P99_LIMIT);
    if (failed.length) {
      console.error(`✖ ${failed.length} scenario(s) over the limits (errors > 1 % or p99 > ${P99_LIMIT} ms):`, failed.map((r) => r.scenario).join(', '));
      process.exitCode = 1;
    } else {
      console.log(`✔ All scenarios within limits (errors ≤ 1 %, p99 ≤ ${P99_LIMIT} ms). Report: loadtest-report.json`);
    }
  } finally {
    child.kill();
    await mongod.stop();
    await fs.rm(uploads, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
