import type { ColumnLayoutMemento } from '../../src/host/columnLayoutStore';

/** In-memory stand-in for `vscode.Memento`, with the same serialization boundary. */
export class MemoryMemento implements ColumnLayoutMemento {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    // VS Code removes a global-state key when it is updated with undefined.
    if (value === undefined) {
      this.values.delete(key);
      return;
    }
    // Mirror a persistent store's serialization boundary.
    this.values.set(key, JSON.parse(JSON.stringify(value)));
  }
}
