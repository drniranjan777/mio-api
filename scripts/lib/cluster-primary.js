/* eslint-disable no-console */
/**
 * Runs src/server.js in API_WORKERS worker processes sharing one port — what PM2
 * cluster mode does on the server. Used by `npm run loadtest -- --workers N`.
 * Prints "CLUSTER_READY <n>" once every worker is listening.
 */
import cluster from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workers = Math.max(1, Number(process.env.API_WORKERS) || 1);

// Round-robin like Linux/PM2 (Windows otherwise leaves balancing to the OS).
cluster.schedulingPolicy = cluster.SCHED_RR;
cluster.setupPrimary({ exec: path.join(root, 'src/server.js') });

let listening = 0;
let stopping = false;
cluster.on('listening', () => {
  if (++listening === workers) console.log(`CLUSTER_READY ${workers}`);
});
cluster.on('exit', (worker, code) => {
  if (stopping) return;
  console.error(`API worker ${worker.id} exited (${code}) — stopping`);
  stop(1);
});

function stop(code = 0) {
  stopping = true;
  for (const w of Object.values(cluster.workers)) w.process.kill();
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

for (let i = 0; i < workers; i++) cluster.fork({ NODE_APP_INSTANCE: String(i), API_WORKERS: String(workers) });
