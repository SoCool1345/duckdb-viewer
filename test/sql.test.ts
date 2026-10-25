import { describe, expect, it } from 'vitest';
import { buildFullCellQuery, buildPageQuery, pickRowidAlias, quoteIdent } from '../src/shared/sql';
import type { QueryColumn } from '../src/shared/sql';

const columns: QueryColumn[] = [
  { name: 'id', dataType: 'BIGINT' },
  { name: 'name', dataType: 'VARCHAR' },
  { name: 'amount', dataType: 'DECIMAL(10,2)' },
];

function build(overrides: Partial<Parameters<typeof buildPageQuery>[0]> = {}) {
  return buildPageQuery({
    schema: 'main',
    table: 'users',
    kind: 'table',
    columns,
    pageSize: 100,
    cursor: { kind: 'rowid' },
    maxCellChars: 4096,
    ...overrides,
  });
}

describe('quoteIdent', () => {
  it('escapes embedded double quotes and neutralises structural input', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('with"quote')).toBe('"with""quote"');
    expect(quoteIdent('a"; drop table users; --')).toBe('"a""; drop table users; --"');
  });
});

describe('buildPageQuery', () => {
  it('uses rowid keyset paging for an unsorted base table', () => {
    const built = build();
    expect(built.paging).toBe('keyset');
    expect(built.sql).toContain('ORDER BY rowid ASC');
    expect(built.sql).not.toContain('OFFSET');
    expect(built.params).toEqual([]);
  });

  it('walks forward from a rowid cursor', () => {
    const built = build({ cursor: { kind: 'rowid', after: '42' } });
    expect(built.sql).toContain('rowid > CAST(? AS BIGINT)');
    expect(built.params).toEqual(['42']);
    expect(built.reversed).toBe(false);
  });

  it('reverses the scan when walking backwards and orders the outer query descending', () => {
    const built = build({ cursor: { kind: 'rowid', before: '42' } });
    expect(built.sql).toContain('rowid < CAST(? AS BIGINT)');
    // The inner scan must descend, otherwise LIMIT would return the oldest
    // rows of the table instead of the rows just before the cursor.
    expect(built.sql).toMatch(/ORDER BY rowid DESC LIMIT \d+/);
    expect(built.reversed).toBe(true);
    expect(built.sql).toMatch(/ORDER BY "__page"\."__duckdb_viewer_rowid" DESC$/);
  });

  it('falls back to offset paging for views', () => {
    const built = buildPageQuery({
      schema: 'main',
      table: 'active_users',
      kind: 'view',
      columns,
      pageSize: 50,
      cursor: { kind: 'offset', offset: 100 },
      maxCellChars: 4096,
    });
    expect(built.paging).toBe('offset');
    expect(built.sql).toContain('LIMIT 51');
    expect(built.sql).toContain('OFFSET 100');
    expect(built.sql).not.toContain('rowid');
  });

  it('sorts by multiple keys with a rowid tiebreak and repeats the order outside the subquery', () => {
    const built = build({ sort: { column: 'name', direction: 'desc' } });
    expect(built.paging).toBe('offset');
    expect(built.sql).toContain('ORDER BY "name" DESC, rowid ASC');
    expect(built.sql).toMatch(/ORDER BY "__page"\."name" DESC, "__page"\."__duckdb_viewer_rowid" ASC$/);
  });

  it('binds filter values as parameters and never inlines them', () => {
    const injected = "x'); drop table users; --";
    const built = build({ filter: { column: 'name', op: 'contains', value: injected } });
    expect(built.sql).toContain('contains(CAST("name" AS VARCHAR), ?)');
    expect(built.sql).not.toContain('drop table');
    expect(built.params).toEqual([injected]);
  });

  it('compares numeric columns using their own type, not DOUBLE', () => {
    const built = build({ filter: { column: 'amount', op: 'gt', value: '10' } });
    expect(built.sql).toContain('"amount" > CAST(? AS DECIMAL(10,2))');
    expect(built.sql).not.toContain('AS DOUBLE');
    expect(built.params).toEqual(['10']);
  });

  it('keeps big integers exact', () => {
    const built = build({
      table: 'numbers',
      columns: [{ name: 'big', dataType: 'BIGINT' }],
      filter: { column: 'big', op: 'eq', value: '9007199254740993' },
    });
    expect(built.sql).toContain('"big" = CAST(? AS BIGINT)');
    expect(built.params).toEqual(['9007199254740993']);
  });

  it('casts temporal parameters to their own type', () => {
    const timeFilter = build({
      table: 'numbers',
      columns: [{ name: 't', dataType: 'TIME' }],
      filter: { column: 't', op: 'gt', value: '12:00:00' },
    });
    expect(timeFilter.sql).toContain('"t" > CAST(? AS TIME)');

    const dateFilter = build({
      table: 'numbers',
      columns: [{ name: 'd', dataType: 'DATE' }],
      filter: { column: 'd', op: 'lt', value: '2024-01-01' },
    });
    expect(dateFilter.sql).toContain('"d" < CAST(? AS DATE)');

    const tsFilter = build({
      table: 'numbers',
      columns: [{ name: 'ts', dataType: 'TIMESTAMP WITH TIME ZONE' }],
      filter: { column: 'ts', op: 'gt', value: '2024-01-01 00:00:00+00' },
    });
    expect(tsFilter.sql).toContain('CAST(? AS TIMESTAMP WITH TIME ZONE)');
  });

  it('renames the internal rowid alias when a user column shadows it', () => {
    const clashing: QueryColumn[] = [
      { name: '__duckdb_viewer_rowid', dataType: 'VARCHAR' },
      { name: 'id', dataType: 'INTEGER' },
    ];
    expect(pickRowidAlias(clashing)).toBe('__duckdb_viewer_rowid_1');
    expect(pickRowidAlias(columns)).toBe('__duckdb_viewer_rowid');

    const built = build({ table: 'aliasclash', columns: clashing, cursor: { kind: 'rowid' } });
    expect(built.rowidAlias).toBe('__duckdb_viewer_rowid_1');
    expect(built.sql).toContain('rowid AS "__duckdb_viewer_rowid_1"');
    expect(built.sql).not.toContain('rowid AS "__duckdb_viewer_rowid",');
  });

  it('falls back to offset paging when a user column shadows rowid', () => {
    const built = build({
      table: 'shadowed',
      columns: [
        { name: 'rowid', dataType: 'VARCHAR' },
        { name: 'id', dataType: 'INTEGER' },
      ],
      cursor: { kind: 'offset', offset: 0 },
    });
    expect(built.paging).toBe('offset');
    expect(built.sql).not.toContain('__duckdb_viewer_rowid');
    expect(built.sql).not.toContain('ORDER BY rowid');
  });

  it('renders blobs with a length prefix and a capped preview', () => {
    const built = build({
      columns: [{ name: 'avatar', dataType: 'BLOB' }],
      maxCellChars: 128,
    });
    expect(built.sql).toContain('octet_length("__page"."avatar")');
    expect(built.sql).toContain('substr(CAST("__page"."avatar" AS VARCHAR), 1, 128)');
  });

  it('cast every column to text so precision survives the JSON boundary', () => {
    const built = build();
    expect(built.sql).toContain('CAST("__page"."amount" AS VARCHAR) AS "amount"');
    expect(built.sql).not.toContain('CAST("__page"."amount" AS DOUBLE)');
  });
});

describe('buildFullCellQuery', () => {
  it('locates a row by rowid and caps the returned text', () => {
    const query = buildFullCellQuery({ schema: 'main', table: 'users', column: 'big_text', rowid: '7', maxChars: 1000 });
    expect(query.sql).toContain('FROM "main"."users"');
    expect(query.sql).toContain('WHERE rowid = CAST(? AS BIGINT)');
    expect(query.sql).toContain('substr(CAST("big_text" AS VARCHAR), 1, 1000)');
    expect(query.params).toEqual(['7']);
  });
});
