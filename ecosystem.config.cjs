/**
 * PM2 process file (production server).
 *   pm2 startOrReload ecosystem.config.cjs && pm2 save
 *
 * With REDIS_URL set (in .env or the shell) the API runs in cluster mode, one
 * worker per CPU (or API_INSTANCES), and rate-limit counters are shared through
 * Redis. Without it, it stays ONE fork-mode process: in-memory counters would
 * otherwise be per worker (the API itself refuses cluster mode without Redis).
 * Everything else that must be shared (OTPs, refresh tokens, counters) is in
 * MongoDB; uploads are on local disk, which all workers on this server share.
 *
 * Switching between fork and cluster needs `pm2 delete mio-api` first —
 * deploy/deploy.sh does that automatically when the mode changes.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Value of KEY from the environment, else from .env (same file the API reads). */
function setting(key) {
  if (process.env[key] !== undefined) return process.env[key].trim();
  try {
    const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
    return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : '';
  } catch {
    return '';
  }
}

const clustered = setting('REDIS_URL') !== '';
const instances = clustered ? (Number(setting('API_INSTANCES')) || 'max') : 1;

module.exports = {
  apps: [
    {
      name: 'mio-api',
      cwd: __dirname,
      script: 'src/server.js',
      node_args: '--env-file=.env',
      instances,
      exec_mode: clustered ? 'cluster' : 'fork',
      max_memory_restart: '400M',
      kill_timeout: 12000,
      time: true,
      // One log file for all workers (otherwise PM2 writes api.out-0.log, -1, …).
      merge_logs: true,
      out_file: '/var/log/miodoctors/api.out.log',
      error_file: '/var/log/miodoctors/api.err.log',
    },
  ],
};
