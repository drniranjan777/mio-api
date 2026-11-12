import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

const run = promisify(execFile);

/** Fake MSG91: records requests; answers per `reply`. */
let reply;
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, url: new URL(req.url, 'http://x'), authkey: req.headers.authkey });
  res.writeHead(reply.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reply.body));
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const msg91Env = () => ({
  ...process.env,
  NODE_ENV: 'test',
  OTP_DEV_MODE: 'false',
  OTP_PEPPER: 'x'.repeat(32),
  JWT_ACCESS_SECRET: 'y'.repeat(48),
  MONGODB_URI: 'mongodb://x',
  SMS_PROVIDER: 'msg91',
  MSG91_AUTH_KEY: 'test-auth-key',
  MSG91_OTP_TEMPLATE_ID: 'tmpl123',
  MSG91_BASE_URL: base,
  STATIC_OTP: '1111',
});

const send = (mobile, code) =>
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const s = await import('./src/modules/auth/sms.provider.js');
       try { await s.activeSmsProvider.sendOtp('${mobile}', '${code}'); console.log('SENT', s.activeSmsProvider.name); }
       catch (e) { console.log('ERR', e.status, e.code); }`,
    ],
    { env: msg91Env(), encoding: 'utf8' },
  );

describe('MSG91 SMS provider', () => {
  it('sends our code to MSG91 with the template and +91 number', async () => {
    reply = { status: 200, body: { type: 'success', request_id: 'abc' } };
    seen.length = 0;
    const { stdout } = await send('9876543210', '4821');
    assert.match(stdout, /SENT msg91/);
    assert.equal(seen.length, 1);
    const [r] = seen;
    assert.equal(r.method, 'POST');
    assert.equal(r.url.pathname, '/api/v5/otp');
    assert.equal(r.url.searchParams.get('mobile'), '919876543210');
    assert.equal(r.url.searchParams.get('otp'), '4821');
    assert.equal(r.url.searchParams.get('template_id'), 'tmpl123');
    assert.equal(r.url.searchParams.get('authkey'), null, 'auth key goes in a header, not the URL');
    assert.equal(r.authkey, 'test-auth-key');
  });

  it('turns MSG91 errors into 502 SMS_FAILED', async () => {
    reply = { status: 200, body: { type: 'error', message: 'Invalid template' } };
    assert.match((await send('9876543210', '4821')).stdout, /ERR 502 SMS_FAILED/);
    reply = { status: 401, body: { type: 'error', message: 'Authentication failure' } };
    assert.match((await send('9876543210', '4821')).stdout, /ERR 502 SMS_FAILED/);
  });

  it('refuses to start with SMS_PROVIDER=msg91 but no keys', () => {
    const env = { ...msg91Env(), MSG91_AUTH_KEY: '' };
    delete env.MSG91_AUTH_KEY;
    const out = spawnSync(process.execPath, ['-e', "import('./src/config/env.js')"], { env, encoding: 'utf8' });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY/);
  });
});
