import { spawn } from 'node:child_process';

const [helperPath, dbPath] = process.argv.slice(2);
if (!helperPath || !dbPath) {
  console.error('usage: orphanHost.mjs <helperPath> <dbPath>');
  process.exit(2);
}

const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'inherit'] });
helper.stdout.on('data', (chunk) => process.stdout.write(chunk));
helper.stdin.write(JSON.stringify({ id: 1, method: 'listSchema', params: { dbPath }, timeoutMs: 5000 }) + '\n');

// Keep the host alive until the test kills it.
setInterval(() => {}, 1000);
