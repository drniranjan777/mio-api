/**
 * PM2 process file (production server).
 *   pm2 startOrReload ecosystem.config.cjs && pm2 save
 * One process on purpose: rate limits and the refresh-token flow keep state
 * per process. Scale by adding a Redis-backed rate limiter first.
 */
module.exports = {
  apps: [
    {
      name: 'mio-api',
      cwd: __dirname,
      script: 'src/server.js',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      kill_timeout: 12000,
      time: true,
      out_file: '/var/log/miodoctors/api.out.log',
      error_file: '/var/log/miodoctors/api.err.log',
    },
  ],
};
