import type { SchemaGroup } from './protocol';

/**
 * Pure in-memory search over schema metadata. It never touches the database:
 * the webview already holds every table, view and column in `ViewerState`.
 */
export type SearchHit =
  | {
      kind: 'object';
      schema: string;
      objectName: string;
      objectKind: 'table' | 'view';
      /** 0 exact, 1 prefix, 2 substring, 3 only a schema/table token matched. */
      quality: number;
    }
  | {
      kind: 'column';
      schema: string;
      objectName: string;
      objectKind: 'table' | 'view';
      columnName: string;
      dataType: string;
      columnIndex: number;
      quality: number;
    };

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  truncated: boolean;
}

export const DEFAULT_SEARCH_LIMIT = 200;

function leafOf(hit: SearchHit): string {
  return hit.kind === 'object' ? hit.objectName : hit.columnName;
}

function qualityOf(leaf: string, tokens: readonly string[]): number {
  let worst = 0;
  for (const token of tokens) {
    const rank = leaf === token ? 0 : leaf.startsWith(token) ? 1 : leaf.includes(token) ? 2 : 3;
    if (rank > worst) worst = rank;
  }
  return worst;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareHits(left: SearchHit, right: SearchHit): number {
  if (left.quality !== right.quality) return left.quality - right.quality;
  if (left.kind !== right.kind) return left.kind === 'object' ? -1 : 1;

  const bySchema = compareText(left.schema, right.schema);
  if (bySchema !== 0) return bySchema;

  const byLeaf = compareText(leafOf(left), leafOf(right));
  if (byLeaf !== 0) return byLeaf;

  if (left.kind === 'column' && right.kind === 'column') {
    const byObject = compareText(left.objectName, right.objectName);
    if (byObject !== 0) return byObject;
    return left.columnIndex - right.columnIndex;
  }

  return 0;
}

export function searchSchema(
  schemas: readonly SchemaGroup[],
  rawQuery: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): SearchResult {
  const tokens = rawQuery
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0 || limit <= 0) {
    return { hits: [], total: 0, truncated: false };
  }

  const hits: SearchHit[] = [];
  for (const group of schemas) {
    const schemaLower = group.name.toLowerCase();
    for (const object of group.objects) {
      const objectLower = object.name.toLowerCase();
      const objectPath = `${schemaLower}.${objectLower}`;

      if (tokens.every((token) => objectPath.includes(token))) {
        hits.push({
          kind: 'object',
          schema: group.name,
          objectName: object.name,
          objectKind: object.kind,
          quality: qualityOf(objectLower, tokens),
        });
      }

      for (const [columnIndex, column] of object.columns.entries()) {
        const columnLower = column.name.toLowerCase();
        // At least one token must hit the column name itself, otherwise
        // searching a table name would list every column of that table.
        if (!tokens.some((token) => columnLower.includes(token))) continue;
        if (!tokens.every((token) => `${objectPath}.${columnLower}`.includes(token))) continue;

        hits.push({
          kind: 'column',
          schema: group.name,
          objectName: object.name,
          objectKind: object.kind,
          columnName: column.name,
          dataType: column.dataType,
          columnIndex,
          quality: qualityOf(columnLower, tokens),
        });
      }
    }
  }

  hits.sort(compareHits);

  const total = hits.length;
  return {
    hits: total > limit ? hits.slice(0, limit) : hits,
    total,
    truncated: total > limit,
  };
}
