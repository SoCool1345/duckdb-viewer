/**
 * Wire protocol between the extension host and the DuckDB helper process.
 *
 * The helper is stateless by design: every request carries the path of the
 * database it needs, and the helper opens/closes a read-only handle inside
 * that single request. There is no "current database" session state.
 */

export type ErrorCode =
  | 'LOCKED'
  | 'VERSION_TOO_NEW'
  | 'CORRUPT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'SQL_ERROR'
  | 'INTERNAL';

export interface HelperErrorPayload {
  code: ErrorCode;
  message: string;
  detail?: string;
  /** Parsed from DuckDB's lock error when code is LOCKED. */
  pid?: number;
  processName?: string;
}

export interface FileFingerprint {
  mtimeMs: number;
  size: number;
  /** Present when a WAL file exists; DuckDB may keep writes there until checkpoint. */
  walMtimeMs?: number;
  walSize?: number;
}

export interface OpenSessionParams {
  dbPath: string;
}

export interface OpenSessionResult {
  version: string;
  fingerprint: FileFingerprint;
}

export interface SchemaColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  default?: string;
  comment?: string;
}

export interface SchemaObject {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: SchemaColumn[];
  estimatedRows?: number;
  sql?: string;
  constraints: Array<{ type: string; columns: string[] }>;
}

export interface SchemaGroup {
  name: string;
  objects: SchemaObject[];
}

export interface ListSchemaResult {
  version: string;
  fingerprint: FileFingerprint;
  schemas: SchemaGroup[];
}

export type FilterOp = 'eq' | 'contains' | 'gt' | 'lt';

export interface FilterSpec {
  column: string;
  op: FilterOp;
  value: string;
}

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export type PageCursor =
  | { kind: 'offset'; offset: number }
  | { kind: 'rowid'; after?: string; before?: string };

export interface FetchPageParams {
  dbPath: string;
  schema: string;
  table: string;
  kind: 'table' | 'view';
  columns: Array<{ name: string; dataType: string }>;
  sort?: SortSpec;
  filter?: FilterSpec;
  pageSize: number;
  cursor: PageCursor;
  maxCellChars: number;
}

export interface PageRow {
  /** Present only for base tables; needed to fetch a full cell value. */
  rowid: string | null;
  cells: Array<string | null>;
  /** Column indexes that were truncated for display. */
  truncated: number[];
}

export interface FetchPageResult {
  columns: Array<{ name: string; dataType: string }>;
  rows: PageRow[];
  paging: 'keyset' | 'offset';
  stableOrder: boolean;
  hasMore: boolean;
  hasPrev: boolean;
  offset: number;
  pageIndex: number;
  estimatedRows: number | null;
  /** True when estimatedRows comes from table statistics rather than count(*). */
  estimated: boolean;
  firstRowid: string | null;
  lastRowid: string | null;
  fingerprint: FileFingerprint;
}

export interface FetchCellParams {
  dbPath: string;
  schema: string;
  table: string;
  column: string;
  rowid: string;
  maxChars: number;
}

export interface FetchCellResult {
  value: string | null;
  truncated: boolean;
}

export interface InterruptParams {
  targetId: number;
}

export interface StatusResult {
  /** Number of database handles currently open. Must be 0 when idle. */
  openHandles: number;
  files: string[];
  version: string;
}

export interface DisposeResult {
  disposed: true;
}

export type Method =
  | 'ping'
  | 'openSession'
  | 'listSchema'
  | 'fetchPage'
  | 'fetchCell'
  | 'status'
  | 'interrupt'
  | 'dispose';

export interface RequestEnvelope {
  id: number;
  method: Method;
  params?: unknown;
  timeoutMs?: number;
}

export interface ResponseEnvelope {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: HelperErrorPayload;
}

export type HelperNotification =
  | { event: 'ready'; pid: number }
  | { event: 'pong'; openHandles: number };

export const DEFAULT_OPERATION_TIMEOUT_MS = 20_000;
export const MAX_FULL_CELL_CHARS = 1_000_000;
