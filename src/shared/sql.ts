import type { FilterSpec, PageCursor, SortSpec } from './protocol';

/**
 * SQL construction for the viewer. User input only ever reaches the query as
 * a bound parameter or as a quoted identifier; it never lands in a position
 * where it could change the statement structure.
 */

export const ROWID_ALIAS = '__duckdb_viewer_rowid';

/**
 * Picks an internal alias that cannot collide with a user column. The rowid
 * pseudo-column is selected as this alias and then joined with `*`, so a
 * collision would silently show the wrong column's data.
 */
export function pickRowidAlias(columns: QueryColumn[]): string {
  const taken = new Set(columns.map((column) => column.name.toLowerCase()));
  let candidate = ROWID_ALIAS;
  let suffix = 0;
  while (taken.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${ROWID_ALIAS}_${suffix}`;
  }
  return candidate;
}

export interface QueryColumn {
  name: string;
  dataType: string;
}

export interface PageQueryInput {
  schema: string;
  table: string;
  kind: 'table' | 'view';
  columns: QueryColumn[];
  sort?: SortSpec;
  filter?: FilterSpec;
  pageSize: number;
  cursor: PageCursor;
  maxCellChars: number;
}

export interface BuiltPageQuery {
  sql: string;
  params: string[];
  paging: 'keyset' | 'offset';
  /** True when rows must be reversed because the query walked backwards. */
  reversed: boolean;
  /** Alias used for the rowid pseudo-column, or null when paging by offset. */
  rowidAlias: string | null;
}

export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export function isBlobType(dataType: string): boolean {
  return /^BLOB(\s|$)/i.test(dataType.trim());
}

/**
 * A table can only be paged with the rowid pseudo-column when the user has
 * not defined a column that shadows it.
 */
export function hasUsableRowid(kind: 'table' | 'view', columns: QueryColumn[]): boolean {
  return kind === 'table' && !columns.some((column) => column.name.toLowerCase() === 'rowid');
}

function numericCastType(dataType: string): string | null {
  const normalized = dataType.trim().toUpperCase().replace(/\s+/g, '');
  if (
    /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|DECIMAL\(\d+,\d+\)|DOUBLE|FLOAT|REAL)$/.test(
      normalized,
    )
  ) {
    return normalized;
  }
  return null;
}

function temporalCastType(dataType: string): string | null {
  const normalized = dataType.trim().toUpperCase().replace(/\s+/g, ' ');
  if (normalized === 'DATE') return 'DATE';
  if (normalized === 'TIME' || normalized === 'TIME WITH TIME ZONE') return normalized;
  if (normalized === 'TIMESTAMP' || normalized === 'TIMESTAMP WITH TIME ZONE' || normalized === 'TIMESTAMPTZ') {
    return normalized === 'TIMESTAMPTZ' ? 'TIMESTAMP WITH TIME ZONE' : normalized;
  }
  return null;
}

function displayExpression(column: QueryColumn, maxChars: number): string {
  const ref = `${quoteIdent('__page')}.${quoteIdent(column.name)}`;
  if (isBlobType(column.dataType)) {
    return (
      `CASE WHEN ${ref} IS NULL THEN NULL ` +
      `ELSE '(' || octet_length(${ref})::VARCHAR || ' bytes) ' || substr(CAST(${ref} AS VARCHAR), 1, ${maxChars}) END ` +
      `AS ${quoteIdent(column.name)}`
    );
  }
  return `CAST(${ref} AS VARCHAR) AS ${quoteIdent(column.name)}`;
}

/**
 * Filter clauses need the column's declared type to compare sensibly:
 * numbers should not be compared lexicographically, and dates should be
 * compared as dates.
 */
function filterClauseFor(column: QueryColumn, filter: FilterSpec): { sql: string; params: string[] } {
  const reference = quoteIdent(column.name);
  if (filter.op === 'contains') {
    return { sql: `contains(CAST(${reference} AS VARCHAR), ?)`, params: [filter.value] };
  }

  const operator = filter.op === 'eq' ? '=' : filter.op === 'gt' ? '>' : '<';
  // Bind through the column's own type. Casting everything to DOUBLE loses
  // precision for BIGINT/HUGEINT/DECIMAL, and casting TIME to TIMESTAMP is
  // not even a valid DuckDB conversion.
  const castType = numericCastType(column.dataType) ?? temporalCastType(column.dataType);
  if (castType) {
    return { sql: `${reference} ${operator} CAST(? AS ${castType})`, params: [filter.value] };
  }
  return { sql: `CAST(${reference} AS VARCHAR) ${operator} ?`, params: [filter.value] };
}

export function buildPageQuery(input: PageQueryInput): BuiltPageQuery {
  const hasRowid = hasUsableRowid(input.kind, input.columns);
  const paging: 'keyset' | 'offset' = hasRowid && !input.sort ? 'keyset' : 'offset';
  const params: string[] = [];
  const where: string[] = [];

  if (input.filter) {
    const column = input.columns.find((candidate) => candidate.name === input.filter?.column);
    if (!column) throw new Error(`Unknown filter column: ${input.filter.column}`);
    const clause = filterClauseFor(column, input.filter);
    where.push(clause.sql);
    params.push(...clause.params);
  }

  let after: string | undefined;
  let before: string | undefined;
  if (paging === 'keyset' && input.cursor.kind === 'rowid') {
    after = input.cursor.after;
    before = input.cursor.before;
  }
  if (after !== undefined) {
    where.push(`rowid > CAST(? AS BIGINT)`);
    params.push(after);
  }
  if (before !== undefined) {
    where.push(`rowid < CAST(? AS BIGINT)`);
    params.push(before);
  }

  const offset = paging === 'offset' && input.cursor.kind === 'offset' ? Math.max(0, input.cursor.offset) : 0;
  const rowidAlias = hasRowid ? pickRowidAlias(input.columns) : null;

  const rowidSelect = rowidAlias ? `rowid AS ${quoteIdent(rowidAlias)}, ` : '';
  const inner = [
    `SELECT ${rowidSelect}* FROM ${qualifiedName(input.schema, input.table)}`,
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    innerOrderBy(input, hasRowid, before !== undefined),
    `LIMIT ${Math.max(1, Math.floor(input.pageSize)) + 1}`,
    paging === 'offset' && offset > 0 ? `OFFSET ${offset}` : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  const outerSelect = [
    ...(rowidAlias
      ? [`${quoteIdent('__page')}.${quoteIdent(rowidAlias)} AS ${quoteIdent(rowidAlias)}`]
      : []),
    ...input.columns.map((column) => displayExpression(column, input.maxCellChars)),
  ].join(', ');

  const outerOrder = outerOrderBy(input, rowidAlias, before !== undefined);
  const sql = `SELECT ${outerSelect} FROM (${inner}) AS ${quoteIdent('__page')} ${outerOrder}`;

  return { sql, params, paging, reversed: before !== undefined, rowidAlias };
}

function innerOrderBy(input: PageQueryInput, hasRowid: boolean, reverse: boolean): string {
  if (reverse) {
    // Walking backwards must scan descending, otherwise LIMIT grabs the
    // oldest rows in the table instead of the ones just before the cursor.
    return `ORDER BY rowid DESC`;
  }
  const parts: string[] = [];
  if (input.sort) {
    parts.push(`${quoteIdent(input.sort.column)} ${input.sort.direction === 'desc' ? 'DESC' : 'ASC'}`);
  }
  if (hasRowid) {
    parts.push('rowid ASC');
  }
  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}

function outerOrderBy(input: PageQueryInput, rowidAlias: string | null, reversed: boolean): string {
  if (reversed) {
    return `ORDER BY ${quoteIdent('__page')}.${quoteIdent(rowidAlias ?? ROWID_ALIAS)} DESC`;
  }
  const parts: string[] = [];
  if (input.sort) {
    parts.push(`${quoteIdent('__page')}.${quoteIdent(input.sort.column)} ${input.sort.direction === 'desc' ? 'DESC' : 'ASC'}`);
  }
  if (rowidAlias) {
    parts.push(`${quoteIdent('__page')}.${quoteIdent(rowidAlias)} ASC`);
  }
  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}

export function buildFullCellQuery(input: { schema: string; table: string; column: string; rowid: string; maxChars: number }): {
  sql: string;
  params: string[];
} {
  const sql =
    `SELECT substr(CAST(${quoteIdent(input.column)} AS VARCHAR), 1, ${Math.max(1, Math.floor(input.maxChars))}) ` +
    `FROM ${qualifiedName(input.schema, input.table)} WHERE rowid = CAST(? AS BIGINT) LIMIT 1`;
  return { sql, params: [input.rowid] };
}

export function buildEstimateQuery(schema: string, table: string): { sql: string; params: string[] } {
  return {
    sql: `SELECT estimated_size FROM duckdb_tables() WHERE schema_name = ? AND table_name = ?`,
    params: [schema, table],
  };
}
