import type { ColumnLayout } from './columnLayout';
import type {
  ErrorCode,
  FetchPageResult,
  FilterOp,
  FilterSpec,
  PageRow,
  SchemaGroup,
  SortSpec,
} from './protocol';

/**
 * Message contract between the webview and the extension host.
 * `WEBVIEW_MESSAGE_TYPES` is the complete set of messages the host accepts;
 * the webview's dispatcher keys are asserted against it in tests.
 */
export const WEBVIEW_MESSAGE_TYPES = [
  'ready',
  'selectObject',
  'sort',
  'filter',
  'clearFilter',
  'setColumnLayout',
  'nextPage',
  'prevPage',
  'refresh',
  'requestFullCell',
  'retryOpen',
  'waitForRelease',
  'cancelOperation',
  'cancelWait',
] as const;

export type WebviewMessageType = (typeof WEBVIEW_MESSAGE_TYPES)[number];

export const HOST_MESSAGE_TYPES = ['state', 'toast', 'cellDetail'] as const;

export type HostMessageType = (typeof HOST_MESSAGE_TYPES)[number];

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'selectObject'; schema: string; name: string; kind: 'table' | 'view' }
  | { type: 'sort'; column: string }
  | { type: 'filter'; column: string; op: FilterOp; value: string }
  | { type: 'clearFilter' }
  | { type: 'setColumnLayout'; schema: string; name: string; kind: 'table' | 'view'; layout: ColumnLayout }
  | { type: 'nextPage' }
  | { type: 'prevPage' }
  | { type: 'refresh' }
  | { type: 'requestFullCell'; rowIndex: number; columnIndex: number }
  | { type: 'retryOpen' }
  | { type: 'waitForRelease' }
  | { type: 'cancelOperation' }
  | { type: 'cancelWait' };

export interface ViewerError {
  code: ErrorCode | 'UNKNOWN';
  message: string;
  hint?: string;
  canRetry: boolean;
}

export interface ViewerState {
  status: 'idle' | 'loading' | 'locked' | 'error' | 'ready';
  dbName: string;
  schemas: SchemaGroup[];
  selected: { schema: string; name: string; kind: 'table' | 'view' } | null;
  /** Column width/hidden/pinned settings for the selected object. */
  columnLayout: ColumnLayout | null;
  columns: Array<{ name: string; dataType: string }>;
  rows: PageRow[];
  pageIndex: number;
  pageSize: number;
  estimatedRows: number | null;
  stableOrder: boolean;
  hasMore: boolean;
  hasPrev: boolean;
  sort: SortSpec | null;
  filter: FilterSpec | null;
  busy: boolean;
  banner: { level: 'info' | 'warn'; text: string } | null;
  lock: { pid?: number; processName?: string; waiting: boolean } | null;
  error: ViewerError | null;
}

export interface HostStateMessage {
  type: 'state';
  state: ViewerState;
}

export interface HostToastMessage {
  type: 'toast';
  level: 'info' | 'error';
  message: string;
}

export interface HostCellDetailMessage {
  type: 'cellDetail';
  text: string | null;
  truncated: boolean;
}

export type HostMessage = HostStateMessage | HostToastMessage | HostCellDetailMessage;

export function emptyState(dbName: string, pageSize: number): ViewerState {
  return {
    status: 'idle',
    dbName,
    schemas: [],
    selected: null,
    columnLayout: null,
    columns: [],
    rows: [],
    pageIndex: 0,
    pageSize,
    estimatedRows: null,
    stableOrder: true,
    hasMore: false,
    hasPrev: false,
    sort: null,
    filter: null,
    busy: false,
    banner: null,
    lock: null,
    error: null,
  };
}

export type { FetchPageResult };
