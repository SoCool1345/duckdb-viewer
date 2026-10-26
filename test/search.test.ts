import { describe, expect, it } from 'vitest';
import type { SchemaColumn, SchemaGroup, SchemaObject } from '../src/shared/protocol';
import { searchSchema, type SearchHit } from '../src/shared/search';

function column(name: string, dataType = 'VARCHAR'): SchemaColumn {
  return { name, dataType, nullable: true };
}

function object(name: string, kind: 'table' | 'view', columns: SchemaColumn[]): SchemaObject {
  return { schema: 'main', name, kind, columns, constraints: [] };
}

function group(name: string, objects: SchemaObject[]): SchemaGroup {
  return { name, objects };
}

function labels(hits: SearchHit[]): string[] {
  return hits.map((hit) => (hit.kind === 'object' ? hit.objectName : `${hit.objectName}.${hit.columnName}`));
}

const schemas: SchemaGroup[] = [
  group('main', [
    object('users', 'table', [column('id', 'INTEGER'), column('email'), column('name')]),
    object('orders', 'table', [column('order_id', 'INTEGER'), column('user_id', 'INTEGER')]),
    object('user_orders', 'table', [column('user_id', 'INTEGER')]),
    object('active_users', 'view', [column('email')]),
  ]),
  group('analytics', [object('events', 'table', [column('event_email')])]),
];

describe('searchSchema', () => {
  it('returns nothing for an empty or whitespace-only query', () => {
    expect(searchSchema(schemas, '')).toEqual({ hits: [], total: 0, truncated: false });
    expect(searchSchema(schemas, '   ')).toEqual({ hits: [], total: 0, truncated: false });
  });

  it('matches names without regard to case', () => {
    const result = searchSchema(schemas, 'USERS');
    expect(labels(result.hits)).toEqual(['users', 'active_users']);
  });

  it('requires every whitespace-separated token to match', () => {
    const result = searchSchema(schemas, 'user orders');
    // The object matches both words; `user_id` also matches because `user`
    // hits the column name and `orders` hits its owning table.
    expect(labels(result.hits)).toEqual(['user_orders', 'orders.user_id', 'user_orders.user_id']);
  });

  it('finds columns even when their table name does not match', () => {
    const result = searchSchema(schemas, 'email');
    expect(labels(result.hits)).toEqual(['active_users.email', 'users.email', 'events.event_email']);
    expect(result.hits[0]).toMatchObject({ kind: 'column', dataType: 'VARCHAR', columnIndex: 0 });
  });

  it('does not list unrelated columns when only the table name matches', () => {
    const result = searchSchema(schemas, 'users');
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.kind === 'object')).toBe(true);
  });

  it('allows a token to match the schema name for a column hit', () => {
    const result = searchSchema(schemas, 'main email');
    expect(labels(result.hits)).toEqual(['active_users.email', 'users.email']);
  });

  it('ranks exact before prefix before substring, and objects before columns', () => {
    const ranked = [
      group('s', [
        object('item', 'table', []),
        object('item_archive', 'table', []),
        object('big_item', 'table', []),
        object('other', 'table', [column('item', 'INTEGER')]),
      ]),
    ];
    const result = searchSchema(ranked, 'item');
    expect(labels(result.hits)).toEqual(['item', 'other.item', 'item_archive', 'big_item']);
  });

  it('orders equal-quality columns by schema, name and column index', () => {
    const tied = [
      group('b', [object('beta', 'table', [column('same')])]),
      group('a', [
        object('alpha', 'table', [column('same'), column('same')]),
        object('gamma', 'table', [column('same')]),
      ]),
    ];
    const result = searchSchema(tied, 'same');
    expect(labels(result.hits)).toEqual(['alpha.same', 'alpha.same', 'gamma.same', 'beta.same']);
    expect(result.hits.map((hit) => (hit.kind === 'column' ? hit.columnIndex : -1))).toEqual([0, 1, 0, 0]);
  });

  it('caps hits at the limit and reports the full match count', () => {
    const wide = Array.from({ length: 250 }, (_, index) => column(`col_${String(index).padStart(3, '0')}`, 'INTEGER'));
    const result = searchSchema([group('main', [object('wide', 'table', wide)])], 'col');
    expect(result.total).toBe(250);
    expect(result.hits).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.hits[0]).toMatchObject({ kind: 'column', columnName: 'col_000' });
    expect(result.hits.at(-1)).toMatchObject({ kind: 'column', columnName: 'col_199' });
  });

  it('does not flag truncation when results fit within the limit', () => {
    const result = searchSchema(schemas, 'email');
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(result.hits.length);
  });

  it('accepts a custom limit', () => {
    const result = searchSchema(schemas, 'email', 2);
    expect(result.total).toBe(3);
    expect(result.hits).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
