/**
 * Pure column-layout logic shared by the host and the webview.
 *
 * A layout only describes presentation: column widths, hidden columns and
 * columns pinned to the left. It never changes which data is read, and column
 * indexes used for sorting, truncation and full-cell requests stay untouched.
 */

export const COLUMN_LAYOUT_VERSION = 1 as const;
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 2000;
/** Width used when a fixed layout needs a width that was never measured. */
export const DEFAULT_COLUMN_WIDTH = 160;

export interface ColumnPref {
  width?: number;
  hidden?: boolean;
  pinned?: boolean;
}

export interface ColumnLayout {
  version: typeof COLUMN_LAYOUT_VERSION;
  columns: Record<string, ColumnPref>;
}

export interface NamedColumn {
  name: string;
}

export interface VisibleColumn<T extends NamedColumn = NamedColumn> {
  column: T;
  /** Index in the object's original column list. */
  originalIndex: number;
  pinned: boolean;
  /** Explicit width from the saved layout, already clamped. */
  width?: number;
}

/**
 * Column names are arbitrary database identifiers, including `__proto__`.
 * A prototype-less dictionary keeps them ordinary keys instead of hitting
 * `Object.prototype` setters.
 */
function createPrefMap(): Record<string, ColumnPref> {
  return Object.create(null) as Record<string, ColumnPref>;
}

function prefOf(layout: ColumnLayout, name: string): ColumnPref | undefined {
  return Object.prototype.hasOwnProperty.call(layout.columns, name)
    ? layout.columns[name]
    : undefined;
}

export function emptyLayout(): ColumnLayout {
  return { version: COLUMN_LAYOUT_VERSION, columns: createPrefMap() };
}

export function clampWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactPref(pref: ColumnPref): ColumnPref | null {
  const next: ColumnPref = {};
  if (pref.width !== undefined && Number.isFinite(pref.width)) next.width = clampWidth(pref.width);
  if (pref.hidden === true) next.hidden = true;
  if (pref.pinned === true) next.pinned = true;
  return next.width !== undefined || next.hidden === true || next.pinned === true ? next : null;
}

/** Parses untrusted persisted/webview data. Invalid fields are dropped. */
export function normalizeLayout(raw: unknown): ColumnLayout {
  const layout = emptyLayout();
  if (!isRecord(raw) || raw.version !== COLUMN_LAYOUT_VERSION || !isRecord(raw.columns)) return layout;

  for (const [name, value] of Object.entries(raw.columns)) {
    if (name.length === 0 || !isRecord(value)) continue;
    const pref: ColumnPref = {};
    if (typeof value.width === 'number') pref.width = value.width;
    if (value.hidden === true) pref.hidden = true;
    if (value.pinned === true) pref.pinned = true;
    const compact = compactPref(pref);
    if (compact) layout.columns[name] = compact;
  }

  return layout;
}

export function isLayoutEmpty(layout: ColumnLayout): boolean {
  return Object.keys(layout.columns).length === 0;
}

export function isColumnHidden(layout: ColumnLayout, name: string): boolean {
  return prefOf(layout, name)?.hidden === true;
}

function withPref(layout: ColumnLayout, name: string, pref: ColumnPref | null): ColumnLayout {
  const columns = createPrefMap();
  for (const [columnName, columnPref] of Object.entries(layout.columns)) {
    columns[columnName] = columnPref;
  }
  if (pref) columns[name] = pref;
  else delete columns[name];
  return { version: COLUMN_LAYOUT_VERSION, columns };
}

export function setPref(layout: ColumnLayout, name: string, patch: Partial<ColumnPref>): ColumnLayout {
  const current = prefOf(layout, name) ?? {};
  return withPref(layout, name, compactPref({ ...current, ...patch }));
}

export function setColumnWidth(layout: ColumnLayout, name: string, width: number): ColumnLayout {
  return setPref(layout, name, { width });
}

export function resetColumnWidth(layout: ColumnLayout, name: string): ColumnLayout {
  return setPref(layout, name, { width: undefined });
}

export function hideColumn(layout: ColumnLayout, name: string, hidden = true): ColumnLayout {
  return setPref(layout, name, { hidden });
}

export function pinColumn(layout: ColumnLayout, name: string, pinned = true): ColumnLayout {
  return setPref(layout, name, { pinned });
}

/** Makes every column visible again while keeping widths and pinning. */
export function showAllColumns(layout: ColumnLayout): ColumnLayout {
  const columns = createPrefMap();
  for (const [name, pref] of Object.entries(layout.columns)) {
    const compact = compactPref({ ...pref, hidden: false });
    if (compact) columns[name] = compact;
  }
  return { version: COLUMN_LAYOUT_VERSION, columns };
}

export function resetLayout(): ColumnLayout {
  return emptyLayout();
}

/** Visible columns in render order: pinned first (original order), then the rest. */
export function visibleColumns<T extends NamedColumn>(
  columns: readonly T[],
  layout: ColumnLayout,
): VisibleColumn<T>[] {
  const pinned: VisibleColumn<T>[] = [];
  const rest: VisibleColumn<T>[] = [];

  columns.forEach((column, originalIndex) => {
    const pref = prefOf(layout, column.name);
    if (pref?.hidden === true) return;
    const entry: VisibleColumn<T> = {
      column,
      originalIndex,
      pinned: pref?.pinned === true,
    };
    if (pref?.width !== undefined) entry.width = clampWidth(pref.width);
    if (entry.pinned) pinned.push(entry);
    else rest.push(entry);
  });

  return pinned.concat(rest);
}

export function hiddenColumns<T extends NamedColumn>(columns: readonly T[], layout: ColumnLayout): T[] {
  return columns.filter((column) => prefOf(layout, column.name)?.hidden === true);
}

/** A fixed table layout is required once a column is pinned or explicitly sized. */
export function fixedLayoutRequired(visible: readonly VisibleColumn[]): boolean {
  return visible.some((entry) => entry.pinned || entry.width !== undefined);
}

/**
 * Widths for every visible column in a fixed layout:
 * explicit width → measured width → default.
 */
export function filledWidths(
  visible: readonly VisibleColumn[],
  measured: Readonly<Record<string, number>> = {},
): number[] {
  return visible.map((entry) => {
    if (entry.width !== undefined) return clampWidth(entry.width);
    const measuredWidth = measured[entry.column.name];
    if (measuredWidth !== undefined && Number.isFinite(measuredWidth) && measuredWidth > 0) {
      return clampWidth(measuredWidth);
    }
    return DEFAULT_COLUMN_WIDTH;
  });
}

/** `left` offsets for pinned columns; unpinned columns get `null`. */
export function stickyOffsets(
  widths: readonly number[],
  pinned: readonly boolean[],
): Array<number | null> {
  let offset = 0;
  return widths.map((width, index) => {
    if (pinned[index] !== true) return null;
    const left = offset;
    offset += width;
    return left;
  });
}

/**
 * Adds measured/default widths for every visible column that has no explicit
 * width. Used before entering a fixed layout or persisting a resize so the
 * switch from auto widths does not visibly jump.
 */
export function materializeWidths<T extends NamedColumn>(
  layout: ColumnLayout,
  visible: readonly VisibleColumn<T>[],
  measured: Readonly<Record<string, number>> = {},
): ColumnLayout {
  let next = layout;
  for (const entry of visible) {
    if (entry.width !== undefined) continue;
    const measuredWidth = measured[entry.column.name];
    const width =
      measuredWidth !== undefined && Number.isFinite(measuredWidth) && measuredWidth > 0
        ? clampWidth(measuredWidth)
        : DEFAULT_COLUMN_WIDTH;
    next = setColumnWidth(next, entry.column.name, width);
  }
  return next;
}
