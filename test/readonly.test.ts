import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';

const fixture = path.resolve('.tmp/fixtures/fixture.duckdb');

describe('read-only access mode', () => {
  it('rejects writes and leaves the file untouched', async () => {
    const before = fs.statSync(fixture);

    const instance = await DuckDBInstance.create(fixture, { access_mode: 'READ_ONLY' });
    const connection = await instance.connect();
    try {
      await expect(connection.run(`insert into users (id, name) values (9999, 'nope')`)).rejects.toThrow(
        /read-only mode/i,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const after = fs.statSync(fixture);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
});
