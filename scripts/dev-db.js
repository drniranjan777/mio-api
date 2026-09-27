/* eslint-disable no-console */
/**
 * Local development MongoDB without a system install.
 * Uses the official mongod binary that mongodb-memory-server already
 * downloaded, with data persisted in backend/.data/db (on this drive).
 *
 *   npm run db        # start (Ctrl+C to stop)
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MongoBinary } from 'mongodb-memory-server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, '.data', 'db');
mkdirSync(dbPath, { recursive: true });

const port = process.env.MONGO_PORT ?? '27017';
const bin = await MongoBinary.getPath();
console.log(`mongod: ${bin}\ndata:   ${dbPath}\nport:   ${port} (localhost only)`);

const child = spawn(bin, ['--dbpath', dbPath, '--port', port, '--bind_ip', '127.0.0.1'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
