import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { formatCell } from '../shared/format';
import { buildEstimateQuery, buildFullCellQuery, buildPageQuery, hasUsableRowid } from '../shared/sql';
import { MAX_FULL_CELL_CHARS } from '../shared/protocol';
import type {
  FetchCellParams,
  FetchCellResult,
  FetchPageParams,
  FetchPageResult,
  FileFingerprint,
  PageRow,
} from '../shared/protocol';

function toText(value: DuckDBValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

async function estimateRows(
  connection: DuckDBConnection,
  schema: string,
  table: string,
): Promise<number | null> {
  try {
    const query = buildEstimateQuery(schema, table);
    const reader = await connection.runAndReadAll(query.sql, query.params);
    const rows = reader.getRows();
    if (rows.length === 0) return null;
    const parsed = Number(rows[0]?.[0]);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function fetchPage(
  connection: DuckDBConnection,
  params: FetchPageParams,
  fingerprint: FileFingerprint,
): Promise<FetchPageResult> {
  const built = buildPageQuery({
    schema: params.schema,
    table: params.table,
    kind: params.kind,
    columns: params.columns,
    ...(params.sort ? { sort: params.sort } : {}),
    ...(params.filter ? { filter: params.filter } : {}),
    pageSize: params.pageSize,
    cursor: params.cursor,
    maxCellChars: params.maxCellChars,
  });

  const reader = await connection.runAndReadAll(built.sql, built.params);
  const names = reader.columnNames();
  const rawRows = reader.getRows();

  const hasRowid = hasUsableRowid(params.kind, params.columns);
  const rowidIndex = hasRowid && built.rowidAlias ? names.indexOf(built.rowidAlias) : -1;
  const firstDataIndex = hasRowid ? rowidIndex + 1 : 0;

  const mapped: PageRow[] = [];
  let lastRowid: string | null = null;
  let firstRowid: string | null = null;

  const limit = Math.max(1, Math.floor(params.pageSize));
  const pageRows = rawRows.slice(0, limit);
  const extra = rawRows.length > limit;
  const rows = built.reversed ? [...pageRows].reverse() : pageRows;

  for (const raw of rows) {
    const rowid = rowidIndex >= 0 ? toText(raw[rowidIndex]) : null;
    const cells: Array<string | null> = [];
    const truncated: number[] = [];
    for (let index = 0; index < params.columns.length; index += 1) {
      const column = params.columns[index];
      if (!column) continue;
      const formatted = formatCell(toText(raw[firstDataIndex + index]), column.dataType, params.maxCellChars);
      cells.push(formatted.text);
      if (formatted.truncated) truncated.push(index);
    }
    if (rowid !== null) {
      firstRowid ??= rowid;
      lastRowid = rowid;
    }
    mapped.push({ rowid, cells, truncated });
  }

  const offset = built.paging === 'offset' && params.cursor.kind === 'offset' ? params.cursor.offset : 0;
  const hasMore = built.reversed ? true : extra;
  const hasPrev = built.reversed ? extra : built.paging === 'keyset' && params.cursor.kind === 'rowid' && params.cursor.after !== undefined;

  const estimatedRows = params.kind === 'table' ? await estimateRows(connection, params.schema, params.table) : null;

  const result: FetchPageResult = {
    columns: params.columns,
    rows: mapped,
    paging: built.paging,
    stableOrder: hasRowid,
    hasMore,
    hasPrev,
    offset,
    pageIndex: Math.floor(offset / Math.max(1, params.pageSize)),
    estimatedRows,
    estimated: estimatedRows !== null,
    firstRowid,
    lastRowid,
    fingerprint,
  };
  return result;
}

export async function fetchCell(
  connection: DuckDBConnection,
  params: FetchCellParams,
): Promise<FetchCellResult> {
  const maxChars = Math.min(Math.max(1, params.maxChars), MAX_FULL_CELL_CHARS);
  const query = buildFullCellQuery({
    schema: params.schema,
    table: params.table,
    column: params.column,
    rowid: params.rowid,
    maxChars,
  });
  const reader = await connection.runAndReadAll(query.sql, query.params);
  const rows = reader.getRows();
  const raw = rows[0]?.[0];
  const text = raw === null || raw === undefined ? null : String(raw);
  return { value: text, truncated: text !== null && text.length >= maxChars };
}
