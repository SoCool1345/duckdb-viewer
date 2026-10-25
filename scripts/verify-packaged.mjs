// Verifies the packaged helper works from an extracted .vsix, without the repo's node_modules.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const helperPath = process.argv[2];
const dbPath = process.argv[3];
if (!helperPath) throw new Error('usage: verify-packaged.mjs <helperPath> [dbPath]');

const child = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
const responses = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.event) console.log('event:', message.event, 'pid:', message.pid);
      else {
        responses.set(message.id, message);
        console.log('response:', message.id, message.ok ? 'ok' : message.error);
      }
    }
    newline = buffer.indexOf('\n');
  }
});

function send(id, method, params) {
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
      }
    }, 20);
  });
}

const fixture = dbPath ?? path.resolve('.tmp/fixtures/fixture.duckdb');
const opened = await send(1, 'openSession', { dbPath: fixture });
const schema = await send(2, 'listSchema', { dbPath: fixture });
const status = await send(3, 'status', {});
const dispose = await send(4, 'dispose', {});

console.log('version:', opened.result?.version);
console.log('schemas:', schema.result?.schemas?.map((group) => `${group.name}(${group.objects.length})`).join(', '));
console.log('openHandles at rest:', status.result?.openHandles);
console.log('disposed:', dispose.result?.disposed);

const ok =
  opened.ok &&
  schema.ok &&
  status.result?.openHandles === 0 &&
  dispose.result?.disposed === true &&
  fs.existsSync(helperPath);
setTimeout(() => process.exit(ok ? 0 : 1), 200);
