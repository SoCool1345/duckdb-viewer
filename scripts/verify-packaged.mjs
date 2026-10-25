// Verifies the packaged helper works from an extracted .vsix, without the repo's node_modules.
// Extract the vsix outside the repository: Node resolves modules upward, so an extracted tree
// inside the repo would silently fall back to the repo's own node_modules.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const helperPath = process.argv[2];
const dbPath = process.argv[3];
if (!helperPath) throw new Error('usage: verify-packaged.mjs <helperPath> [dbPath]');

if (!fs.existsSync(helperPath)) {
  console.error(`helper not found: ${helperPath}`);
  process.exit(1);
}

const child = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
let childFailure;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.event) {
        console.log('event:', message.event, 'pid:', message.pid);
      } else {
        console.log('response:', message.id, message.ok ? 'ok' : message.error);
        const waiter = pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          pending.delete(message.id);
          waiter.resolve(message);
        }
      }
    }
    newline = buffer.indexOf('\n');
  }
});

function failAll(reason) {
  childFailure ??= reason;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.resolve({ ok: false, error: { code: 'HELPER_EXITED', message: reason } });
  }
  pending.clear();
}

child.on('error', (error) => failAll(`helper failed to start: ${error.message}`));
child.on('close', (code, signal) => failAll(`helper exited before responding (code ${code}, signal ${signal})`));
child.stdin.on('error', () => {});

function send(id, method, params) {
  if (childFailure) {
    return Promise.resolve({ id, ok: false, error: { code: 'HELPER_EXITED', message: childFailure } });
  }

  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, error: { code: 'TIMEOUT', message: 'no response within 10s' } });
    }, 10_000);
    pending.set(id, {
      timer,
      resolve: (message) => {
        clearTimeout(timer);
        resolve({ id, ...message });
      },
    });
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
  opened.ok === true &&
  schema.ok === true &&
  status.ok === true &&
  dispose.ok === true &&
  status.result?.openHandles === 0 &&
  dispose.result?.disposed === true;
setTimeout(() => process.exit(ok ? 0 : 1), 200);
