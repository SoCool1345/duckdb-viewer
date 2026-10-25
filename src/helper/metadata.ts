import type { DuckDBConnection, DuckDBResultReader, DuckDBValue } from '@duckdb/node-api';
import type { SchemaColumn, SchemaGroup, SchemaObject } from '../shared/protocol';

const SYSTEM_SCHEMAS = ['information_schema', 'pg_catalog'];

function asString(value: DuckDBValue | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text.length > 0 ? text : undefined;
}

function asNumber(value: DuckDBValue | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asStringArray(value: DuckDBValue | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  // DuckDB LIST values arrive as DuckDBListValue { items: [...] }.
  const candidate = value as unknown as { items?: unknown; values?: unknown };
  if (Array.isArray(candidate.items)) return candidate.items.map((entry) => String(entry));
  if (Array.isArray(candidate.values)) return candidate.values.map((entry) => String(entry));
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      // Not JSON; treat as empty.
    }
  }
  return [];
}

function readRows(reader: DuckDBResultReader): Record<string, DuckDBValue>[] {
  return reader.getRowObjects();
}

const TABLE_QUERY = `
  select schema_name, table_name, estimated_size, sql
  from duckdb_tables()
  where not internal and not temporary
    and schema_name not in ('information_schema', 'pg_catalog')
  order by schema_name, table_name`;

const VIEW_QUERY = `
  select schema_name, view_name, sql
  from duckdb_views()
  where not internal and not temporary
    and schema_name not in ('information_schema', 'pg_catalog')
  order by schema_name, view_name`;

const COLUMN_QUERY = `
  select schema_name, table_name, column_name, data_type, is_nullable, column_default, comment
  from duckdb_columns()
  where schema_name not in ('information_schema', 'pg_catalog', 'temp')
  order by schema_name, table_name, column_index`;

const CONSTRAINT_QUERY = `
  select schema_name, table_name, constraint_type, constraint_column_names
  from duckdb_constraints()
  where schema_name not in ('information_schema', 'pg_catalog', 'temp')`;

/**
 * Reads all viewer metadata in one connection: three catalog queries, no
 * per-node round trips. Expanding a schema in the tree never touches the DB.
 */
export async function listSchema(connection: DuckDBConnection): Promise<SchemaGroup[]> {
  const tables = readRows(await connection.runAndReadAll(TABLE_QUERY));
  const views = readRows(await connection.runAndReadAll(VIEW_QUERY));
  const columns = readRows(await connection.runAndReadAll(COLUMN_QUERY));
  const constraints = readRows(await connection.runAndReadAll(CONSTRAINT_QUERY));

  const columnsByTable = new Map<string, SchemaColumn[]>();
  for (const row of columns) {
    const schema = asString(row.schema_name) ?? '';
    const table = asString(row.table_name) ?? '';
    const key = `${schema}\u0000${table}`;
    const list = columnsByTable.get(key) ?? [];
    list.push({
      name: asString(row.column_name) ?? '',
      dataType: asString(row.data_type) ?? '',
      nullable: row.is_nullable !== false,
      ...(asString(row.column_default) ? { default: asString(row.column_default) } : {}),
      ...(asString(row.comment) ? { comment: asString(row.comment) } : {}),
    });
    columnsByTable.set(key, list);
  }

  const constraintsByTable = new Map<string, Array<{ type: string; columns: string[] }>>();
  for (const row of constraints) {
    const schema = asString(row.schema_name) ?? '';
    const table = asString(row.table_name) ?? '';
    const key = `${schema}\u0000${table}`;
    const list = constraintsByTable.get(key) ?? [];
    list.push({
      type: asString(row.constraint_type) ?? '',
      columns: asStringArray(row.constraint_column_names),
    });
    constraintsByTable.set(key, list);
  }

  const bySchema = new Map<string, SchemaObject[]>();

  const push = (object: SchemaObject): void => {
    const list = bySchema.get(object.schema) ?? [];
    list.push(object);
    bySchema.set(object.schema, list);
  };

  for (const row of tables) {
    const schema = asString(row.schema_name) ?? '';
    const name = asString(row.table_name) ?? '';
    const key = `${schema}\u0000${name}`;
    push({
      schema,
      name,
      kind: 'table',
      columns: columnsByTable.get(key) ?? [],
      constraints: constraintsByTable.get(key) ?? [],
      ...(asNumber(row.estimated_size) !== undefined ? { estimatedRows: asNumber(row.estimated_size) } : {}),
      ...(asString(row.sql) ? { sql: asString(row.sql) } : {}),
    });
  }

  for (const row of views) {
    const schema = asString(row.schema_name) ?? '';
    const name = asString(row.view_name) ?? '';
    const key = `${schema}\u0000${name}`;
    push({
      schema,
      name,
      kind: 'view',
      columns: columnsByTable.get(key) ?? [],
      constraints: constraintsByTable.get(key) ?? [],
      ...(asString(row.sql) ? { sql: asString(row.sql) } : {}),
    });
  }

  return [...bySchema.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, objects]) => ({
      name,
      objects: objects.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'table' ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
    }))
    .filter((group) => !SYSTEM_SCHEMAS.includes(group.name));
}
