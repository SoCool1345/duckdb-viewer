// Generates deterministic DuckDB fixtures used by unit and integration tests.
// Run with: npm run fixtures
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('.tmp/fixtures');
fs.mkdirSync(outDir, { recursive: true });

async function withConnection(dbPath, fn, options) {
  const instance = await DuckDBInstance.create(dbPath, options);
  const connection = await instance.connect();
  try {
    await fn(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function fresh(dbPath) {
  for (const suffix of ['', '.wal', '.tmp']) {
    fs.rmSync(dbPath + suffix, { force: true, recursive: true });
  }
  return dbPath;
}

async function createMain() {
  const dbPath = fresh(path.join(outDir, 'fixture.duckdb'));
  await withConnection(dbPath, async (c) => {
    await c.run(`create schema analytics`);
    await c.run(`
      create table users (
        id bigint primary key,
        name varchar not null,
        score decimal(38, 10),
        balance hugeint,
        external_id uuid,
        created_at timestamptz,
        tags varchar[],
        profile struct(city varchar, age integer, scores integer[]),
        avatar blob,
        note varchar,
        big_text varchar
      )`);
    await c.run(`
      insert into users values
        (1, 'alice', 12345678901234567890.1234567890, 170141183460469231731687303715884105727,
         '00000000-0000-0000-0000-000000000001', '2024-01-02 03:04:05+00',
         ['a', 'b'], {'city': 'AMS', 'age': 34, 'scores': [1, 2, 3]}, '\\x01\\x02'::blob, NULL, 'short'),
        (2, 'bob', -0.0000000001, -170141183460469231731687303715884105728,
         '00000000-0000-0000-0000-000000000002', '2024-01-02 03:04:05.123456+00',
         [], NULL, ''::blob, 'has note', repeat('x', 9000))`);
    await c.run(`
      create table orders (
        order_id integer,
        user_id bigint,
        amount decimal(10, 2),
        placed_at date
      )`);
    await c.run(`
      insert into orders
      select i, (i % 2) + 1, i * 1.25, date '2024-01-01' + i::integer
      from range(1, 51) t(i)`);
    await c.run(`
      create table analytics.events (
        event_id bigint,
        kind varchar,
        payload json
      )`);
    await c.run(`
      insert into analytics.events values
        (1, 'click', '{"x": 1, "y": [1, 2]}'),
        (2, 'view', NULL)`);
    await c.run(`
      create view active_users as
      select id, name from main.users where note is not null`);
    await c.run(`
      create view slow_view as
      select sum(hash(i))::hugeint as n from range(400000000) t(i)`);
    await c.run(`
      create table numbers (
        id bigint,
        big bigint,
        hue hugeint,
        dec decimal(38, 10),
        t time,
        d date,
        ts timestamp
      )`);
    await c.run(`
      insert into numbers values
        (1, 9007199254740993, 170141183460469231731687303715884105727,
         12345678901234567890.1234567890, time '12:34:56', date '2024-05-06', timestamp '2024-05-06 12:34:56'),
        (2, 9007199254740992, -170141183460469231731687303715884105728,
         -0.0000000001, time '01:00:00', date '2020-01-01', timestamp '2020-01-01 01:00:00')`);
    await c.run(`
      create table shadowed (rowid varchar, id integer)`);
    await c.run(`insert into shadowed values ('a', 1), ('b', 2), ('c', 3)`);
    await c.run(`
      create table aliasclash ("__duckdb_viewer_rowid" varchar, id integer)`);
    await c.run(`insert into aliasclash values ('actual-user-value', 1), ('second', 2)`);
    await c.run(`
      create table "weird name" ("select" integer, "with""quote" varchar)`);
    await c.run(`insert into "weird name" values (1, 'ok')`);
  });
  return dbPath;
}

async function createEmpty() {
  const dbPath = fresh(path.join(outDir, 'empty.duckdb'));
  await withConnection(dbPath, async (c) => {
    await c.run(`create table placeholder (id integer)`);
    await c.run(`drop table placeholder`);
  });
  return dbPath;
}

const fixture = await createMain();
const empty = await createEmpty();
console.log(JSON.stringify({ fixture, empty }, null, 2));
