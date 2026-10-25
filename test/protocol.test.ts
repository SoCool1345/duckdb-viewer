import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelperClient, RpcError } from '../src/host/rpcClient';
import type {
  FetchPageResult,
  ListSchemaResult,
  OpenSessionResult,
  StatusResult,
} from '../src/shared/protocol';

const helperPath = path.resolve('dist/helper.js');
const fixture = path.resolve('.tmp/fixtures/fixture.duckdb');
const emptyDb = path.resolve('.tmp/fixtures/empty.duckdb');

const orderColumns = [
  { name: 'order_id', dataType: 'INTEGER' },
  { name: 'user_id', dataType: 'BIGINT' },
  { name: 'amount', dataType: 'DECIMAL(10,2)' },
  { name: 'placed_at', dataType: 'DATE' },
];

const slowColumns = [{ name: 'n', dataType: 'HUGEINT' }];

const slowPageParams = {
  dbPath: fixture,
  schema: 'main',
  table: 'slow_view',
  kind: 'view' as const,
  columns: slowColumns,
  pageSize: 10,
  cursor: { kind: 'offset' as const, offset: 0 },
  maxCellChars: 128,
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let client: HelperClient;

beforeAll(() => {
  client = new HelperClient({ helperPath, heartbeatMs: 500 });
});

afterAll(async () => {
  await client.dispose();
});

async function readStatus(): Promise<StatusResult> {
  return client.request<StatusResult>('status', undefined, 5000);
}

async function expectNoOpenHandles(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = await readStatus();
  while (Date.now() < deadline) {
    if (last.openHandles === 0) return;
    await delay(100);
    last = await readStatus();
  }
  throw new Error(`Helper still reports ${last.openHandles} open handle(s): ${last.files.join(', ')}`);
}

describe('helper protocol', () => {
  it('opens a session and reports the DuckDB version', async () => {
    const result = await client.request<OpenSessionResult>('openSession', { dbPath: fixture });
    expect(result.version).toMatch(/^v?\d+\.\d+/);
    expect(result.fingerprint.size).toBeGreaterThan(0);
    await expectNoOpenHandles();
  });

  it('returns the schema in a single request', async () => {
    const result = await client.request<ListSchemaResult>('listSchema', { dbPath: fixture });
    const main = result.schemas.find((group) => group.name === 'main');
    expect(main).toBeDefined();

    const users = main?.objects.find((object) => object.name === 'users');
    expect(users?.kind).toBe('table');
    expect(users?.columns).toHaveLength(11);
    expect(users?.columns.find((column) => column.name === 'name')?.nullable).toBe(false);
    expect(users?.constraints.some((constraint) => constraint.type === 'PRIMARY KEY')).toBe(true);
    const primaryKey = users?.constraints.find((constraint) => constraint.type === 'PRIMARY KEY');
    expect(primaryKey?.columns).toEqual(['id']);
    expect(users?.estimatedRows).toBe(2);

    const view = main?.objects.find((object) => object.name === 'active_users');
    expect(view?.kind).toBe('view');
    expect(view?.constraints).toEqual([]);
    await expectNoOpenHandles();
  });

  it('returns an empty schema for a database without user tables', async () => {
    const result = await client.request<ListSchemaResult>('listSchema', { dbPath: emptyDb });
    expect(result.schemas).toEqual([]);
    await expectNoOpenHandles();
  });

  it('pages a base table with rowid keyset paging', async () => {
    const first = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'orders',
      kind: 'table',
      columns: orderColumns,
      pageSize: 10,
      cursor: { kind: 'rowid' },
      maxCellChars: 4096,
    });

    expect(first.paging).toBe('keyset');
    expect(first.stableOrder).toBe(true);
    expect(first.rows).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(first.hasPrev).toBe(false);
    expect(first.estimatedRows).toBe(50);
    expect(first.estimated).toBe(true);
    expect(first.rows[0]?.cells[0]).toBe('1');
    expect(first.rows[0]?.rowid).not.toBeNull();

    const second = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'orders',
      kind: 'table',
      columns: orderColumns,
      pageSize: 10,
      cursor: { kind: 'rowid', after: String(first.lastRowid) },
      maxCellChars: 4096,
    });

    expect(second.rows[0]?.cells[0]).toBe('11');
    expect(second.hasPrev).toBe(true);
    const firstIds = new Set(first.rows.map((row) => row.cells[0]));
    for (const row of second.rows) expect(firstIds.has(row.cells[0])).toBe(false);
    await expectNoOpenHandles();
  });

  it('marks views as unstable and pages them by offset', async () => {
    const result = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'active_users',
      kind: 'view',
      columns: [
        { name: 'id', dataType: 'BIGINT' },
        { name: 'name', dataType: 'VARCHAR' },
      ],
      pageSize: 10,
      cursor: { kind: 'offset', offset: 0 },
      maxCellChars: 4096,
    });

    expect(result.paging).toBe('offset');
    expect(result.stableOrder).toBe(false);
    expect(result.rows[0]?.rowid).toBeNull();
    expect(result.estimatedRows).toBeNull();
    expect(result.estimated).toBe(false);
    await expectNoOpenHandles();
  });

  it('sorts with a deterministic tiebreak and resets to offset paging', async () => {
    const result = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'orders',
      kind: 'table',
      columns: orderColumns,
      sort: { column: 'amount', direction: 'desc' },
      pageSize: 5,
      cursor: { kind: 'offset', offset: 0 },
      maxCellChars: 4096,
    });

    expect(result.paging).toBe('offset');
    expect(result.stableOrder).toBe(true);
    expect(result.rows.map((row) => row.cells[0])).toEqual(['50', '49', '48', '47', '46']);
    await expectNoOpenHandles();
  });

  it('filters without inlining user input', async () => {
    const result = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'users',
      kind: 'table',
      columns: [
        { name: 'id', dataType: 'BIGINT' },
        { name: 'name', dataType: 'VARCHAR' },
      ],
      filter: { column: 'name', op: 'contains', value: "bob'; drop table users; --" },
      pageSize: 10,
      cursor: { kind: 'rowid' },
      maxCellChars: 4096,
    });

    expect(result.rows).toHaveLength(0);
    // The table is still there and readable.
    const stillThere = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'users',
      kind: 'table',
      columns: [{ name: 'id', dataType: 'BIGINT' }],
      pageSize: 10,
      cursor: { kind: 'rowid' },
      maxCellChars: 4096,
    });
    expect(stillThere.rows.length).toBeGreaterThan(0);
    await expectNoOpenHandles();
  });

  it('truncates large values and can return the full cell on demand', async () => {
    const page = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'users',
      kind: 'table',
      columns: [{ name: 'big_text', dataType: 'VARCHAR' }],
      pageSize: 10,
      cursor: { kind: 'rowid' },
      maxCellChars: 64,
    });

    const truncatedRow = page.rows.find((row) => row.truncated.includes(0));
    expect(truncatedRow).toBeDefined();
    expect(truncatedRow?.cells[0]?.length).toBe(64);

    const full = await client.request<{ value: string | null; truncated: boolean }>('fetchCell', {
      dbPath: fixture,
      schema: 'main',
      table: 'users',
      column: 'big_text',
      rowid: String(truncatedRow?.rowid),
      maxChars: 1_000_000,
    });
    expect(full.value).toHaveLength(9000);
    expect(full.truncated).toBe(false);
    await expectNoOpenHandles();
  });

  it('reports zero open handles after repeated requests', async () => {
    for (let index = 0; index < 10; index += 1) {
      await client.request('listSchema', { dbPath: fixture });
    }
    const status = await readStatus();
    expect(status.openHandles).toBe(0);
    expect(status.files).toEqual([]);
  });

  it('abandons a timed-out query and releases the handle', async () => {
    await expect(
      client.request(
        'fetchPage',
        {
          dbPath: fixture,
          schema: 'main',
          table: 'slow_view',
          kind: 'view',
          columns: slowColumns,
          pageSize: 10,
          cursor: { kind: 'offset', offset: 0 },
          maxCellChars: 128,
        },
        50,
      ),
    ).rejects.toSatisfy((error: unknown) => error instanceof RpcError && error.payload.code === 'TIMEOUT');

    await expectNoOpenHandles(5000);
  });

  it('cancels an in-flight request on demand and releases the handle', async () => {
    let targetId = 0;
    const pending = client.request(
      'fetchPage',
      {
        dbPath: fixture,
        schema: 'main',
        table: 'slow_view',
        kind: 'view',
        columns: slowColumns,
        pageSize: 10,
        cursor: { kind: 'offset', offset: 0 },
        maxCellChars: 128,
      },
      15_000,
      (id) => {
        targetId = id;
      },
    );

    await delay(100);
    await client.request('interrupt', { targetId }, 5000);
    await expect(pending).rejects.toSatisfy((error: unknown) => error instanceof RpcError && error.payload.code === 'CANCELLED');
    await expectNoOpenHandles(5000);
  });

  it('normalises precision-heavy and nested values to text', async () => {
    const result = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'users',
      kind: 'table',
      columns: [
        { name: 'score', dataType: 'DECIMAL(38,10)' },
        { name: 'balance', dataType: 'HUGEINT' },
        { name: 'external_id', dataType: 'UUID' },
        { name: 'tags', dataType: 'VARCHAR[]' },
        { name: 'profile', dataType: 'STRUCT(city VARCHAR, age INTEGER, scores INTEGER[])' },
        { name: 'avatar', dataType: 'BLOB' },
        { name: 'note', dataType: 'VARCHAR' },
      ],
      pageSize: 10,
      cursor: { kind: 'rowid' },
      maxCellChars: 4096,
    });

    const row = result.rows[0];
    expect(row?.cells[0]).toBe('12345678901234567890.1234567890');
    expect(row?.cells[1]).toBe('170141183460469231731687303715884105727');
    expect(row?.cells[2]).toBe('00000000-0000-0000-0000-000000000001');
    expect(row?.cells[3]).toBe('[a, b]');
    expect(row?.cells[4]).toContain("'city': AMS");
    expect(row?.cells[5]).toMatch(/^\(2 bytes\)/);
    expect(row?.cells[6]).toBeNull();
    await expectNoOpenHandles();
  });

  it('returns the rows immediately before the cursor when paging back', async () => {
    const fetchPageAt = (cursor: { kind: 'rowid'; after?: string; before?: string }) =>
      client.request<FetchPageResult>('fetchPage', {
        dbPath: fixture,
        schema: 'main',
        table: 'orders',
        kind: 'table',
        columns: orderColumns,
        pageSize: 10,
        cursor,
        maxCellChars: 4096,
      });

    const first = await fetchPageAt({ kind: 'rowid' });
    const second = await fetchPageAt({ kind: 'rowid', after: String(first.lastRowid) });
    const third = await fetchPageAt({ kind: 'rowid', after: String(second.lastRowid) });

    expect(third.rows.map((row) => row.cells[0])).toEqual([
      '21',
      '22',
      '23',
      '24',
      '25',
      '26',
      '27',
      '28',
      '29',
      '30',
    ]);

    const back = await fetchPageAt({ kind: 'rowid', before: String(third.firstRowid) });
    expect(back.rows.map((row) => row.cells[0])).toEqual([
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
    ]);
    await expectNoOpenHandles();
  });

  it('filters BIGINT exactly and TIME columns without conversion errors', async () => {
    const columns = [
      { name: 'id', dataType: 'BIGINT' },
      { name: 'big', dataType: 'BIGINT' },
      { name: 't', dataType: 'TIME' },
    ];
    const fetchWith = (filter: { column: string; op: 'eq' | 'gt'; value: string }) =>
      client.request<FetchPageResult>('fetchPage', {
        dbPath: fixture,
        schema: 'main',
        table: 'numbers',
        kind: 'table',
        columns,
        filter,
        pageSize: 10,
        cursor: { kind: 'rowid' },
        maxCellChars: 4096,
      });

    const exact = await fetchWith({ column: 'big', op: 'eq', value: '9007199254740993' });
    expect(exact.rows.map((row) => row.cells[0])).toEqual(['1']);

    const time = await fetchWith({ column: 't', op: 'gt', value: '12:00:00' });
    expect(time.rows.map((row) => row.cells[0])).toEqual(['1']);
    await expectNoOpenHandles();
  });

  it('degrades to offset paging when a user column is named rowid', async () => {
    const result = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'shadowed',
      kind: 'table',
      columns: [
        { name: 'rowid', dataType: 'VARCHAR' },
        { name: 'id', dataType: 'INTEGER' },
      ],
      pageSize: 10,
      cursor: { kind: 'offset', offset: 0 },
      maxCellChars: 4096,
    });

    expect(result.paging).toBe('offset');
    expect(result.stableOrder).toBe(false);
    expect(result.rows[0]?.rowid).toBeNull();
    expect(result.rows[0]?.cells).toEqual(['a', '1']);
    await expectNoOpenHandles();
  });

  it('does not let the rowid alias collide with a user column', async () => {
    const result = await client.request<FetchPageResult>('fetchPage', {
      dbPath: fixture,
      schema: 'main',
      table: 'aliasclash',
      kind: 'table',
      columns: [
        { name: '__duckdb_viewer_rowid', dataType: 'VARCHAR' },
        { name: 'id', dataType: 'INTEGER' },
      ],
      pageSize: 10,
      cursor: { kind: 'rowid' },
      maxCellChars: 4096,
    });

    expect(result.paging).toBe('keyset');
    expect(result.rows[0]?.cells).toEqual(['actual-user-value', '1']);
    expect(result.rows[0]?.rowid).not.toBeNull();
    expect(result.rows[0]?.rowid).not.toBe('actual-user-value');
  });

  it('does not execute a queued request that already timed out', async () => {
    const slow = {
      dbPath: fixture,
      schema: 'main',
      table: 'slow_view',
      kind: 'view' as const,
      columns: slowColumns,
      pageSize: 10,
      cursor: { kind: 'offset' as const, offset: 0 },
      maxCellChars: 128,
    };
    const isAbandoned = (error: unknown): boolean =>
      error instanceof RpcError && (error.payload.code === 'TIMEOUT' || error.payload.code === 'CANCELLED');

    const first = client.request('fetchPage', slow, 50);
    const second = client.request('fetchPage', slow, 50);
    await expect(first).rejects.toSatisfy(isAbandoned);
    await expect(second).rejects.toSatisfy(isAbandoned);

    await delay(300);
    expect((await readStatus()).openHandles).toBe(0);
    await expectNoOpenHandles(3000);
  });

  it('reports a missing file instead of crashing', async () => {
    await expect(client.request('listSchema', { dbPath: path.resolve('.tmp/fixtures/nope.duckdb') })).rejects.toSatisfy(
      (error: unknown) => error instanceof RpcError && error.payload.code === 'NOT_FOUND',
    );
    await expectNoOpenHandles();
  });

  it('exits within one second when its stdin closes', async () => {
    const child = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Helper did not announce itself')), 10_000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const started = Date.now();
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once('exit', (value) => resolve(value)));
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not let a stopping helper reject requests to its replacement', async () => {
    const temporary = new HelperClient({ helperPath });
    await temporary.request('ping', undefined, 5000);

    // Stop the current helper but do not wait: the next request spawns a new
    // process while the old one is still shutting down.
    const stopping = temporary.shutdown();
    let replacementRequestId = 0;
    const pending = temporary.request<FetchPageResult>('fetchPage', slowPageParams, 10_000, (id) => {
      replacementRequestId = id;
    });

    await delay(300);
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) =>
          `rejected:${error instanceof RpcError ? error.payload.code : String(error)}`,
      ),
      delay(150).then(() => 'pending'),
    ]);
    expect(outcome).toBe('pending');

    await temporary.request('interrupt', { targetId: replacementRequestId }, 5000);
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => error instanceof RpcError && error.payload.code === 'CANCELLED',
    );
    await stopping;
    await temporary.dispose();
  });

  it('stops the helper process on dispose', async () => {
    const temporary = new HelperClient({ helperPath });
    const pong = await temporary.request<{ pid: number }>('ping', undefined, 5000);
    expect(pong.pid).toBeGreaterThan(0);

    await temporary.dispose();

    const deadline = Date.now() + 3000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pong.pid, 0);
        await delay(100);
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);
  });
});
