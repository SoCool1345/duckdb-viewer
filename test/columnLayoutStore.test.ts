import { describe, expect, it } from 'vitest';
import {
  COLUMN_LAYOUT_STORAGE_PREFIX,
  ColumnLayoutStore,
  columnLayoutKey,
  columnLayoutStorageKey,
} from '../src/host/columnLayoutStore';
import { emptyLayout, normalizeLayout } from '../src/shared/columnLayout';
import { MemoryMemento } from './helpers/memoryMemento';

const DB = 'C:/data/test.duckdb';
const OTHER_DB = 'C:/data/other.duckdb';
const USERS = { schema: 'main', name: 'users', kind: 'table' as const };
const ORDERS = { schema: 'main', name: 'orders', kind: 'table' as const };

describe('column layout keys', () => {
  it('separates all identity parts, including table vs view', () => {
    expect(columnLayoutKey(DB, USERS)).toBe(`C:/data/test.duckdb\u0000main\u0000users\u0000table`);
    expect(columnLayoutKey(DB, { ...USERS, kind: 'view' })).not.toBe(columnLayoutKey(DB, USERS));
  });

  it('derives a stable, bounded global-state key per object', () => {
    const usersKey = columnLayoutStorageKey(DB, USERS);
    expect(usersKey.startsWith(COLUMN_LAYOUT_STORAGE_PREFIX)).toBe(true);
    expect(usersKey).toBe(columnLayoutStorageKey(DB, USERS));
    expect(usersKey).not.toBe(columnLayoutStorageKey(DB, ORDERS));
    expect(usersKey).not.toBe(columnLayoutStorageKey(DB, { ...USERS, kind: 'view' }));
    expect(usersKey).not.toBe(columnLayoutStorageKey(OTHER_DB, USERS));
    expect(usersKey.length).toBeLessThan(120);
  });
});

describe('ColumnLayoutStore', () => {
  it('loads an empty layout for objects that were never saved', () => {
    const store = new ColumnLayoutStore(new MemoryMemento());
    expect(store.load(DB, USERS)).toEqual(emptyLayout());
  });

  it('round-trips a layout per object', async () => {
    const store = new ColumnLayoutStore(new MemoryMemento());
    const layout = {
      version: 1 as const,
      columns: { id: { width: 240, pinned: true }, name: { hidden: true } },
    };

    await store.save(DB, USERS, layout);
    expect(store.load(DB, USERS)).toEqual(layout);
  });

  it('isolates objects, same-named columns and database files', async () => {
    const store = new ColumnLayoutStore(new MemoryMemento());
    await store.save(DB, USERS, { version: 1, columns: { id: { width: 200 } } });
    await store.save(DB, ORDERS, { version: 1, columns: { id: { hidden: true } } });
    await store.save(OTHER_DB, USERS, { version: 1, columns: { id: { pinned: true } } });

    expect(store.load(DB, USERS).columns.id).toEqual({ width: 200 });
    expect(store.load(DB, ORDERS).columns.id).toEqual({ hidden: true });
    expect(store.load(OTHER_DB, USERS).columns.id).toEqual({ pinned: true });
  });

  it('restores layouts through a new store backed by the same memento', async () => {
    const memento = new MemoryMemento();
    const first = new ColumnLayoutStore(memento);
    await first.save(DB, USERS, { version: 1, columns: { name: { width: 180 } } });

    const second = new ColumnLayoutStore(memento);
    expect(second.load(DB, USERS)).toEqual({ version: 1, columns: { name: { width: 180 } } });
  });

  it('does not let two windows overwrite each other', async () => {
    const memento = new MemoryMemento();
    const windowA = new ColumnLayoutStore(memento);
    const windowB = new ColumnLayoutStore(memento);

    // A caches users, then B saves orders from a store that never saw users.
    await windowA.save(DB, USERS, { version: 1, columns: { name: { hidden: true } } });
    await windowB.save(DB, ORDERS, { version: 1, columns: { id: { pinned: true } } });

    expect(windowA.load(DB, USERS).columns.name).toEqual({ hidden: true });
    expect(windowA.load(DB, ORDERS).columns.id).toEqual({ pinned: true });
    expect(windowB.load(DB, USERS).columns.name).toEqual({ hidden: true });
  });

  it('normalizes stored values instead of trusting them', async () => {
    const memento = new MemoryMemento();
    const store = new ColumnLayoutStore(memento);
    await store.save(DB, USERS, {
      version: 1,
      columns: { id: { width: 5, hidden: false }, name: { hidden: true } },
    });

    expect(store.load(DB, USERS)).toEqual({ version: 1, columns: { id: { width: 60 }, name: { hidden: true } } });
  });

  it('ignores corrupted entries', () => {
    const memento = new MemoryMemento();
    memento.values.set(columnLayoutStorageKey(DB, USERS), {
      version: 2,
      columns: { id: { hidden: true } },
    });
    memento.values.set(columnLayoutStorageKey(DB, ORDERS), 'nope');

    const store = new ColumnLayoutStore(memento);
    expect(store.load(DB, USERS)).toEqual(emptyLayout());
    expect(store.load(DB, ORDERS)).toEqual(emptyLayout());
  });

  it('deletes an object entry when an empty layout is saved', async () => {
    const memento = new MemoryMemento();
    const store = new ColumnLayoutStore(memento);
    const key = columnLayoutStorageKey(DB, USERS);

    await store.save(DB, USERS, { version: 1, columns: { id: { width: 200 } } });
    expect(memento.values.has(key)).toBe(true);

    await store.save(DB, USERS, emptyLayout());
    expect(store.load(DB, USERS)).toEqual(emptyLayout());
    expect(memento.values.has(key)).toBe(false);
  });

  it('does not expose stored layouts for mutation', async () => {
    const store = new ColumnLayoutStore(new MemoryMemento());
    await store.save(DB, USERS, { version: 1, columns: { id: { width: 200 } } });

    const loaded = store.load(DB, USERS);
    loaded.columns.id = { hidden: true };
    expect(store.load(DB, USERS).columns.id).toEqual({ width: 200 });
  });

  it('round-trips a layout for a column literally named __proto__', async () => {
    const store = new ColumnLayoutStore(new MemoryMemento());
    const layout = normalizeLayout(
      JSON.parse('{"version":1,"columns":{"__proto__":{"hidden":true,"width":200}}}'),
    );

    await store.save(DB, USERS, layout);
    const loaded = store.load(DB, USERS);
    expect(Object.prototype.hasOwnProperty.call(loaded.columns, '__proto__')).toBe(true);
    expect(loaded.columns['__proto__']).toEqual({ hidden: true, width: 200 });
  });
});
