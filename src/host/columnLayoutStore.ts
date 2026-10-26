import { createHash } from 'node:crypto';
import { isLayoutEmpty, normalizeLayout } from '../shared/columnLayout';
import type { ColumnLayout } from '../shared/columnLayout';

/** Identifies the object whose column layout is being stored. */
export interface ColumnLayoutTarget {
  schema: string;
  name: string;
  kind: 'table' | 'view';
}

/**
 * The small slice of `vscode.Memento` this store needs. Keeping it structural
 * lets the store run against an in-memory implementation in unit tests.
 */
export interface ColumnLayoutMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface ColumnLayoutSource {
  load(dbPath: string, target: ColumnLayoutTarget): ColumnLayout;
  save(dbPath: string, target: ColumnLayoutTarget, layout: ColumnLayout): Promise<void>;
}

/** Every object gets its own key so windows cannot overwrite each other. */
export const COLUMN_LAYOUT_STORAGE_PREFIX = 'duckdbViewer.columnLayout.v1.';

/** `dbPath` + object identity; `\u0000` cannot appear in a path or identifier. */
export function columnLayoutKey(dbPath: string, target: ColumnLayoutTarget): string {
  return [dbPath, target.schema, target.name, target.kind].join('\u0000');
}

/** Hashed so arbitrary paths and identifiers never become oversized keys. */
export function columnLayoutStorageKey(dbPath: string, target: ColumnLayoutTarget): string {
  const digest = createHash('sha256').update(columnLayoutKey(dbPath, target), 'utf8').digest('hex');
  return `${COLUMN_LAYOUT_STORAGE_PREFIX}${digest}`;
}

/**
 * Persists one layout per database object under its own global-state key.
 * No read cache is kept: another window may write a different object between
 * our reads, and each save only touches the object it owns.
 */
export class ColumnLayoutStore implements ColumnLayoutSource {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly memento: ColumnLayoutMemento) {}

  /** Waits for writes issued so far so deactivation cannot drop an update. */
  flush(): Promise<void> {
    return this.pending;
  }

  load(dbPath: string, target: ColumnLayoutTarget): ColumnLayout {
    const raw = this.memento.get<unknown>(columnLayoutStorageKey(dbPath, target), null);
    return normalizeLayout(raw);
  }

  async save(dbPath: string, target: ColumnLayoutTarget, layout: ColumnLayout): Promise<void> {
    const normalized = normalizeLayout(layout);
    const key = columnLayoutStorageKey(dbPath, target);
    // `Memento.update(key, undefined)` removes the key.
    const value = isLayoutEmpty(normalized) ? undefined : normalized;
    const write = Promise.resolve(this.memento.update(key, value));
    this.pending = Promise.allSettled([this.pending, write]).then(() => undefined);
    await write;
  }
}
