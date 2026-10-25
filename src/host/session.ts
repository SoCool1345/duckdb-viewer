import { emptyState } from '../shared/messages';
import type { ViewerState, WebviewMessage as WebviewMessageType } from '../shared/messages';
import type {
  FetchCellResult,
  FetchPageParams,
  FetchPageResult,
  FileFingerprint,
  FilterOp,
  ListSchemaResult,
  PageCursor,
  SchemaObject,
  SortSpec,
} from '../shared/protocol';
import { presentError } from './present';
import { HelperClient, RpcError } from './rpcClient';

export type Selection = { schema: string; name: string; kind: 'table' | 'view' };

export interface DbSessionOptions {
  dbPath: string;
  dbName: string;
  client: HelperClient;
  pageSize: number;
  operationTimeoutMs: number;
  maxCellBytes: number;
  /** Poll interval while waiting for another process to release the database. */
  waitIntervalMs?: number;
  onState: (state: ViewerState) => void;
  onBusyChange: (busy: boolean) => void;
  onCellDetail: (text: string | null, truncated: boolean) => void;
  onToast: (level: 'info' | 'error', message: string) => void;
}

class LockedSignal extends Error {}

/** Thrown when an async continuation resumes after the tab was closed. */
class SessionDisposed extends Error {}

const EXTERNAL_CHANGE_TEXT = '检测到外部写入，当前展示的数据可能已变化。';

/**
 * Owns one database tab's reading state. Every method that touches the
 * database does so through a queued request; between requests the session
 * holds no handle whatsoever.
 */
export class DbSession {
  private state: ViewerState;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private busy = false;
  private waiting = false;
  private waitCancelled = false;
  private waitTimer: NodeJS.Timeout | undefined;
  private waitResolve: (() => void) | undefined;
  private fingerprint: FileFingerprint | undefined;
  private paging: 'keyset' | 'offset' = 'offset';
  private pageIndex = 0;
  private activeRequestId: number | undefined;

  constructor(private readonly options: DbSessionOptions) {
    this.state = emptyState(options.dbName, options.pageSize);
  }

  get dbPath(): string {
    return this.options.dbPath;
  }

  /** Test/diagnostic hook: the state currently shown in the editor. */
  snapshot(): ViewerState {
    return { ...this.state };
  }

  start(): void {
    this.enqueue(async () => {
      await this.reloadSchema();
      await this.selectFirstObject();
    });
  }

  dispose(): void {
    // Closing a tab must release the lock immediately, not when the query
    // happens to finish or times out.
    this.cancelCurrent();
    this.disposed = true;
    this.waitCancelled = true;
    this.cancelWait();
  }

  /** Called when the user explicitly releases the lock (helper is stopped). */
  onHelperStopped(): void {
    this.waitCancelled = true;
    this.setBusy(false);
  }

  handleMessage(message: unknown): void {
    const parsed = message as WebviewMessageType | undefined;
    if (!parsed || typeof parsed.type !== 'string') return;

    if (this.waiting && parsed.type !== 'cancelWait') return;

    switch (parsed.type) {
      case 'ready':
        this.emit();
        break;
      case 'selectObject':
        this.enqueue(() => this.selectObject({ schema: parsed.schema, name: parsed.name, kind: parsed.kind }));
        break;
      case 'sort':
        this.enqueue(() => this.toggleSort(parsed.column));
        break;
      case 'filter':
        this.enqueue(() => this.applyFilter(parsed.column, parsed.op, parsed.value));
        break;
      case 'clearFilter':
        this.enqueue(() => this.clearFilter());
        break;
      case 'nextPage':
        this.enqueue(() => this.nextPage());
        break;
      case 'prevPage':
        this.enqueue(() => this.prevPage());
        break;
      case 'refresh':
        this.enqueue(async () => {
          // Refreshing adopts whatever is on disk now as the new baseline, so
          // a stale-data banner must not survive it.
          this.fingerprint = undefined;
          this.mutate({ banner: null });
          await this.reloadSchema();
          await this.reloadCurrentPage();
        });
        break;
      case 'requestFullCell':
        this.enqueue(() => this.requestFullCell(parsed.rowIndex, parsed.columnIndex));
        break;
      case 'retryOpen':
        this.waitCancelled = true;
        this.enqueue(async () => {
          await this.reloadSchema();
          await this.selectFirstObject();
        });
        break;
      case 'waitForRelease':
        this.startWaiting();
        break;
      case 'cancelOperation':
        this.cancelCurrent();
        break;
      case 'cancelWait':
        this.cancelWait();
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- internals

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.disposed) return;
      this.setBusy(true);
      try {
        await task();
      } catch (error) {
        if (!(error instanceof LockedSignal) && !(error instanceof SessionDisposed)) this.reportError(error);
      } finally {
        this.setBusy(false);
      }
    });
    this.queue = next.catch(() => undefined);
    return next.catch(() => undefined);
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.options.onBusyChange(busy);
    this.mutate({ busy });
  }

  private mutate(patch: Partial<ViewerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.options.onState(this.state);
  }

  private assertActive(): void {
    if (this.disposed) throw new SessionDisposed();
  }

  private reportError(error: unknown): void {
    if (error instanceof RpcError) {
      if (error.payload.code === 'LOCKED') {
        this.enterLocked(error.payload);
        return;
      }
      if (error.payload.code === 'CANCELLED') {
        this.mutate({ status: 'ready', busy: false });
        return;
      }
      this.mutate({
        status: 'error',
        busy: false,
        error: presentError(error.payload),
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.mutate({
      status: 'error',
      busy: false,
      error: { code: 'UNKNOWN', message, canRetry: true },
    });
  }

  private enterLocked(payload: { pid?: number; processName?: string }): void {
    this.mutate({
      status: 'locked',
      busy: false,
      error: null,
      lock: { ...(payload.pid !== undefined ? { pid: payload.pid } : {}), ...(payload.processName ? { processName: payload.processName } : {}), waiting: false },
    });
  }

  private async callListSchema(): Promise<ListSchemaResult> {
    try {
      return await this.call<ListSchemaResult>('listSchema', { dbPath: this.options.dbPath });
    } catch (error) {
      if (error instanceof RpcError && error.payload.code === 'LOCKED') {
        this.enterLocked(error.payload);
        throw new LockedSignal();
      }
      throw error;
    }
  }

  private call<T>(method: 'listSchema' | 'fetchPage' | 'fetchCell', params: unknown): Promise<T> {
    this.assertActive();
    return this.options.client
      .request<T>(method, params, this.options.operationTimeoutMs, (id) => {
        this.activeRequestId = id;
      })
      .finally(() => {
        this.activeRequestId = undefined;
      });
  }

  /** Asks the helper to abort the in-flight request; the handle closes with it. */
  cancelCurrent(): void {
    const id = this.activeRequestId;
    if (id === undefined) return;
    void this.options.client.request('interrupt', { targetId: id }, 5000).catch(() => undefined);
  }

  private async reloadSchema(): Promise<void> {
    this.assertActive();
    this.mutate({ status: this.state.status === 'ready' ? 'ready' : 'loading', error: null, lock: null });
    const result = await this.callListSchema();
    this.noteFingerprint(result.fingerprint);
    this.mutate({ schemas: result.schemas, status: 'ready', error: null, lock: null });
    this.syncSelectionWithSchema();
  }

  private noteFingerprint(fingerprint: FileFingerprint): void {
    const previous = this.fingerprint;
    const changed =
      previous !== undefined &&
      (previous.mtimeMs !== fingerprint.mtimeMs ||
        previous.size !== fingerprint.size ||
        previous.walMtimeMs !== fingerprint.walMtimeMs ||
        previous.walSize !== fingerprint.walSize);
    if (changed) {
      this.mutate({ banner: { level: 'warn', text: EXTERNAL_CHANGE_TEXT } });
    }
    this.fingerprint = fingerprint;
  }

  private syncSelectionWithSchema(): void {
    const selected = this.state.selected;
    if (!selected) return;
    const object = this.findObject(selected);
    if (!object) {
      this.mutate({ selected: null, columns: [], rows: [], hasMore: false, hasPrev: false, pageIndex: 0 });
      return;
    }
    this.mutate({ columns: object.columns.map((column) => ({ name: column.name, dataType: column.dataType })) });
  }

  private findObject(selection: Selection): SchemaObject | undefined {
    return this.state.schemas
      .find((group) => group.name === selection.schema)
      ?.objects.find((object) => object.name === selection.name && object.kind === selection.kind);
  }

  private async selectFirstObject(): Promise<void> {
    this.assertActive();
    const preserve = this.state.selected;
    if (preserve && this.findObject(preserve)) {
      await this.selectObject(preserve);
      return;
    }
    const group = this.state.schemas.find((candidate) => candidate.objects.length > 0);
    const object = group?.objects[0];
    if (!group || !object) {
      this.mutate({ status: 'ready', selected: null, rows: [], columns: [] });
      return;
    }
    await this.selectObject({ schema: group.name, name: object.name, kind: object.kind });
  }

  private async selectObject(selection: Selection): Promise<void> {
    this.assertActive();
    const object = this.findObject(selection);
    if (!object) return;
    this.mutate({
      selected: selection,
      columns: object.columns.map((column) => ({ name: column.name, dataType: column.dataType })),
      sort: null,
      filter: null,
      pageIndex: 0,
      rows: [],
      hasMore: false,
      hasPrev: false,
      error: null,
      banner: null,
      status: 'ready',
    });
    await this.loadPage(this.firstCursor(), 0);
  }

  private firstCursor(): PageCursor {
    if (this.state.sort) return { kind: 'offset', offset: 0 };
    return this.state.selected?.kind === 'table' ? { kind: 'rowid' } : { kind: 'offset', offset: 0 };
  }

  private async loadPage(cursor: PageCursor, pageIndex: number): Promise<void> {
    this.assertActive();
    const selected = this.state.selected;
    if (!selected) return;

    this.mutate({ status: 'loading' });

    const params: FetchPageParams = {
      dbPath: this.options.dbPath,
      schema: selected.schema,
      table: selected.name,
      kind: selected.kind,
      columns: this.state.columns,
      pageSize: this.options.pageSize,
      cursor,
      maxCellChars: this.options.maxCellBytes,
      ...(this.state.sort ? { sort: this.state.sort } : {}),
      ...(this.state.filter ? { filter: this.state.filter } : {}),
    };

    const result = await this.call<FetchPageResult>('fetchPage', params);

    this.paging = result.paging;
    this.pageIndex = pageIndex;
    this.noteFingerprint(result.fingerprint);
    this.mutate({
      status: 'ready',
      rows: result.rows,
      columns: result.columns,
      estimatedRows: result.estimatedRows,
      stableOrder: result.stableOrder,
      hasMore: result.hasMore,
      hasPrev: pageIndex > 0,
      pageIndex,
      error: null,
    });
  }

  private async reloadCurrentPage(): Promise<void> {
    this.assertActive();
    if (!this.state.selected) return;
    this.mutate({ pageIndex: 0, hasPrev: false });
    await this.loadPage(this.firstCursor(), 0);
  }

  private async nextPage(): Promise<void> {
    this.assertActive();
    if (!this.state.hasMore || !this.state.selected) return;
    if (this.paging === 'keyset') {
      const last = this.state.rows.at(-1)?.rowid;
      if (!last) return;
      await this.loadPage({ kind: 'rowid', after: last }, this.pageIndex + 1);
      return;
    }
    await this.loadPage({ kind: 'offset', offset: (this.pageIndex + 1) * this.options.pageSize }, this.pageIndex + 1);
  }

  private async prevPage(): Promise<void> {
    this.assertActive();
    if (this.pageIndex <= 0 || !this.state.selected) return;
    if (this.paging === 'keyset') {
      const first = this.state.rows[0]?.rowid;
      if (!first) return;
      await this.loadPage({ kind: 'rowid', before: first }, this.pageIndex - 1);
      return;
    }
    await this.loadPage(
      { kind: 'offset', offset: Math.max(0, (this.pageIndex - 1) * this.options.pageSize) },
      Math.max(0, this.pageIndex - 1),
    );
  }

  private async toggleSort(column: string): Promise<void> {
    this.assertActive();
    if (!this.state.selected) return;
    const current = this.state.sort;
    let next: SortSpec | null;
    if (!current || current.column !== column) {
      next = { column, direction: 'asc' };
    } else if (current.direction === 'asc') {
      next = { column, direction: 'desc' };
    } else {
      next = null;
    }
    this.mutate({ sort: next, pageIndex: 0, hasPrev: false });
    await this.loadPage(next ? { kind: 'offset', offset: 0 } : this.firstCursor(), 0);
  }

  private async applyFilter(column: string, op: FilterOp, value: string): Promise<void> {
    this.assertActive();
    if (!this.state.selected) return;
    this.mutate({
      filter: { column, op, value },
      pageIndex: 0,
      hasPrev: false,
    });
    await this.loadPage(this.firstCursor(), 0);
  }

  private async clearFilter(): Promise<void> {
    this.assertActive();
    if (!this.state.filter) return;
    this.mutate({ filter: null, pageIndex: 0, hasPrev: false });
    await this.loadPage(this.firstCursor(), 0);
  }

  private async requestFullCell(rowIndex: number, columnIndex: number): Promise<void> {
    this.assertActive();
    const row = this.state.rows[rowIndex];
    const column = this.state.columns[columnIndex];
    const selected = this.state.selected;
    if (!row || !column || !selected) return;
    if (!row.rowid) {
      this.options.onToast('info', '视图没有 rowid，无法单独定位该行；可缩小筛选范围后重试。');
      return;
    }
    const result = await this.call<FetchCellResult>('fetchCell', {
      dbPath: this.options.dbPath,
      schema: selected.schema,
      table: selected.name,
      column: column.name,
      rowid: row.rowid,
      maxChars: 1_000_000,
    });
    this.options.onCellDetail(result.value, result.truncated);
  }

  // -------------------------------------------------------------- lock waiting

  startWaiting(): void {
    if (this.waiting || this.disposed) return;
    this.waiting = true;
    this.waitCancelled = false;
    this.mutate({
      status: 'locked',
      lock: {
        ...(this.state.lock?.pid !== undefined ? { pid: this.state.lock.pid } : {}),
        ...(this.state.lock?.processName ? { processName: this.state.lock.processName } : {}),
        waiting: true,
      },
    });
    void this.waitLoop();
  }

  cancelWait(): void {
    this.waitCancelled = true;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    this.waitResolve?.();
    this.waitResolve = undefined;
  }

  private async waitLoop(): Promise<void> {
    while (!this.disposed && !this.waitCancelled) {
      try {
        const result = await this.call<ListSchemaResult>('listSchema', { dbPath: this.options.dbPath });
        if (this.disposed) return;
        this.waiting = false;
        this.noteFingerprint(result.fingerprint);
        this.mutate({ schemas: result.schemas, status: 'ready', lock: null, error: null });
        this.syncSelectionWithSchema();
        await this.enqueue(async () => {
          await this.selectFirstObject();
        });
        return;
      } catch (error) {
        if (error instanceof SessionDisposed) return;
        if (!(error instanceof RpcError) || error.payload.code !== 'LOCKED') {
          this.waiting = false;
          this.mutate({ lock: null });
          this.reportError(error);
          return;
        }
      }
      await this.delay(this.options.waitIntervalMs ?? 1000);
    }
    this.waiting = false;
    this.mutate({
      lock: this.state.lock ? { ...this.state.lock, waiting: false } : null,
      status: this.state.schemas.length > 0 ? 'ready' : 'locked',
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.waitResolve = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = undefined;
        this.waitResolve = undefined;
        resolve();
      }, ms);
    });
  }
}
