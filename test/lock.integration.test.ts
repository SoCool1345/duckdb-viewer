import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ColumnLayoutStore } from '../src/host/columnLayoutStore';
import { HelperClient } from '../src/host/rpcClient';
import { DbSession } from '../src/host/session';
import type { FetchPageResult, StatusResult } from '../src/shared/protocol';
import { MemoryMemento } from './helpers/memoryMemento';

const helperPath = path.resolve('dist/helper.js');
const workDir = path.resolve('.tmp/integration');
const baseFixture = path.resolve('.tmp/fixtures/fixture.duckdb');

const userColumns = [
  { name: 'id', dataType: 'BIGINT' },
  { name: 'name', dataType: 'VARCHAR' },
];

function copyFixture(name: string): string {
  fs.mkdirSync(workDir, { recursive: true });
  const target = path.join(workDir, name);
  fs.rmSync(target, { force: true });
  fs.rmSync(`${target}.wal`, { force: true });
  fs.copyFileSync(baseFixture, target);
  return target;
}

function runNode(script: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

function pageParams(dbPath: string): Record<string, unknown> {
  return {
    dbPath,
    schema: 'main',
    table: 'users',
    kind: 'table',
    columns: userColumns,
    pageSize: 10,
    cursor: { kind: 'rowid' },
    maxCellChars: 4096,
  };
}

const clients: HelperClient[] = [];

afterAll(async () => {
  await Promise.all(clients.map((client) => client.dispose()));
});

describe('lock safety', () => {
  it('lets an external process write between viewer reads', async () => {
    const dbPath = copyFixture('writer.duckdb');
    const client = new HelperClient({ helperPath, heartbeatMs: 500 });
    clients.push(client);

    const initial = await client.request<FetchPageResult>('fetchPage', pageParams(dbPath), 10_000);
    const initialFingerprint = initial.fingerprint;

    for (let index = 0; index < 10; index += 1) {
      await client.request('listSchema', { dbPath }, 10_000);
      const page = await client.request<FetchPageResult>('fetchPage', pageParams(dbPath), 10_000);
      expect(page.rows.length).toBeGreaterThan(0);

      const write = await runNode(path.resolve('test/helpers/writer.mjs'), [dbPath, String(1000 + index)]);
      expect(write.stderr).toBe('');
      expect(write.code).toBe(0);
    }

    const status = await client.request<StatusResult>('status', undefined, 5000);
    expect(status.openHandles).toBe(0);

    const finalPage = await client.request<FetchPageResult>(
      'fetchPage',
      {
        ...pageParams(dbPath),
        columns: [
          { name: 'id', dataType: 'BIGINT' },
          { name: 'name', dataType: 'VARCHAR' },
        ],
        filter: { column: 'name', op: 'contains', value: 'external-' },
        pageSize: 20,
      },
      10_000,
    );
    const ids = finalPage.rows.map((row) => row.cells[0]);
    expect(ids).toHaveLength(10);
    expect(ids).toContain('1009');

    const changed =
      finalPage.fingerprint.mtimeMs !== initialFingerprint.mtimeMs ||
      finalPage.fingerprint.size !== initialFingerprint.size ||
      finalPage.fingerprint.walMtimeMs !== initialFingerprint.walMtimeMs ||
      finalPage.fingerprint.walSize !== initialFingerprint.walSize;
    expect(changed).toBe(true);
  });

  it('releases the handle when a tab is closed mid-query', async () => {
    const dbPath = copyFixture('dispose.duckdb');
    const client = new HelperClient({ helperPath, heartbeatMs: 500 });
    clients.push(client);

    const session = new DbSession({
      dbPath,
      dbName: 'dispose.duckdb',
      client,
      pageSize: 10,
      operationTimeoutMs: 20_000,
      maxCellBytes: 128,
      columnLayouts: new ColumnLayoutStore(new MemoryMemento()),
      waitIntervalMs: 50,
      onState: () => undefined,
      onBusyChange: () => undefined,
      onCellDetail: () => undefined,
      onToast: () => undefined,
    });

    session.start();
    await waitFor(async () => (await client.request<StatusResult>('status', undefined, 5000)).openHandles === 0, 5000);

    session.handleMessage({ type: 'selectObject', schema: 'main', name: 'slow_view', kind: 'view' });
    await waitFor(async () => (await client.request<StatusResult>('status', undefined, 5000)).openHandles > 0, 5000);

    const started = Date.now();
    session.dispose();
    await waitFor(async () => (await client.request<StatusResult>('status', undefined, 5000)).openHandles === 0, 5000);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('exits the helper when its parent dies and frees the file', async () => {
    const dbPath = copyFixture('orphan.duckdb');
    const host = spawn(process.execPath, [path.resolve('test/helpers/orphanHost.mjs'), helperPath, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    const helperPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Helper never announced itself')), 15_000);
      host.stdout.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk);
        const match = /"event":"ready","pid":(\d+)/.exec(buffer);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(Number.parseInt(match[1], 10));
        }
      });
      host.on('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new Error(`Orphan host exited early with code ${String(code)}`));
        }
      });
    });

    expect(isAlive(helperPid)).toBe(true);
    host.kill('SIGKILL');

    await waitFor(() => !isAlive(helperPid), 5000);

    const write = await runNode(path.resolve('test/helpers/writer.mjs'), [dbPath, '2000']);
    expect(write.stderr).toBe('');
    expect(write.code).toBe(0);
  });

  it('reads committed WAL data without checkpointing or modifying the files', async () => {
    fs.mkdirSync(workDir, { recursive: true });
    const dbPath = path.join(workDir, 'wal.duckdb');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}.wal`, { force: true });

    const created = await runNode(path.resolve('test/helpers/walWriter.mjs'), [dbPath]);
    expect(created.stderr).toBe('');
    expect(created.code).toBe(0);
    expect(fs.existsSync(`${dbPath}.wal`)).toBe(true);

    const dbBefore = fs.statSync(dbPath);
    const walBefore = fs.statSync(`${dbPath}.wal`);

    const client = new HelperClient({ helperPath, heartbeatMs: 500 });
    clients.push(client);
    try {
      const page = await client.request<FetchPageResult>(
        'fetchPage',
        {
          dbPath,
          schema: 'main',
          table: 't',
          kind: 'table',
          columns: [{ name: 'i', dataType: 'BIGINT' }],
          pageSize: 100,
          cursor: { kind: 'rowid' },
          maxCellChars: 128,
        },
        10_000,
      );

      const values = page.rows.map((row) => row.cells[0]);
      expect(values).toHaveLength(20);
      expect(values).toContain('15');

      const status = await client.request<StatusResult>('status', undefined, 5000);
      expect(status.openHandles).toBe(0);
    } finally {
      await client.dispose();
    }

    const dbAfter = fs.statSync(dbPath);
    const walAfter = fs.statSync(`${dbPath}.wal`);
    expect(dbAfter.size).toBe(dbBefore.size);
    expect(walAfter.size).toBe(walBefore.size);
    expect(walAfter.mtimeMs).toBe(walBefore.mtimeMs);
  });
});
