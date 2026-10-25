import { spawn } from 'node:child_process';

const [dbPath, id] = process.argv.slice(2);
if (!dbPath || !id) {
  console.error('usage: writer.mjs <dbPath> <id>');
  process.exit(2);
}

const { DuckDBInstance } = await import('@duckdb/node-api');
const instance = await DuckDBInstance.create(dbPath);
const connection = await instance.connect();
try {
  await connection.run(`insert into users (id, name) values (?, ?)`, [Number(id), `external-${id}`]);
  console.log('ok');
} finally {
  connection.closeSync();
  instance.closeSync();
}
