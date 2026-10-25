import { DuckDBInstance } from '@duckdb/node-api';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: walWriter.mjs <dbPath>');
  process.exit(2);
}

const instance = await DuckDBInstance.create(dbPath);
const connection = await instance.connect();
await connection.run(`create table t as select range i from range(10)`);
await connection.run(`pragma disable_checkpoint_on_shutdown`);
await connection.run(`insert into t select range from range(10, 20)`);
connection.closeSync();
instance.closeSync();
console.log('wal-ready');
