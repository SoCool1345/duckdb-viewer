import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampWidth,
  emptyLayout,
  filledWidths,
  fixedLayoutRequired,
  hiddenColumns,
  hideColumn,
  isColumnHidden,
  isLayoutEmpty,
  materializeWidths,
  normalizeLayout,
  pinColumn,
  resetColumnWidth,
  resetLayout,
  setColumnWidth,
  setPref,
  showAllColumns,
  stickyOffsets,
  visibleColumns,
} from '../src/shared/columnLayout';

const COLUMNS = [{ name: 'id' }, { name: 'email' }, { name: 'name' }];

describe('normalizeLayout', () => {
  it('discards input that is not a version 1 layout', () => {
    expect(normalizeLayout(null)).toEqual(emptyLayout());
    expect(normalizeLayout([])).toEqual(emptyLayout());
    expect(normalizeLayout({})).toEqual(emptyLayout());
    expect(normalizeLayout({ version: 2, columns: { id: { hidden: true } } })).toEqual(emptyLayout());
    expect(normalizeLayout({ version: 1, columns: [] })).toEqual(emptyLayout());
  });

  it('keeps valid preferences and drops invalid fields', () => {
    const layout = normalizeLayout({
      version: 1,
      columns: {
        id: { width: 123.4, pinned: true, hidden: false, extra: 'ignored' },
        email: { width: 'wide', hidden: true },
        broken: 'nope',
        '': { hidden: true },
        name: { pinned: false, hidden: false },
      },
    });

    expect(layout).toEqual({
      version: 1,
      columns: { id: { width: 123, pinned: true }, email: { hidden: true } },
    });
  });

  it('clamps widths to the usable range', () => {
    expect(clampWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(5_000)).toBe(MAX_COLUMN_WIDTH);
    expect(clampWidth(120.6)).toBe(121);
    expect(normalizeLayout({ version: 1, columns: { a: { width: 5 }, b: { width: 9_000 } } }).columns).toEqual({
      a: { width: MIN_COLUMN_WIDTH },
      b: { width: MAX_COLUMN_WIDTH },
    });
  });

  it('ignores non-finite widths rather than producing NaN', () => {
    expect(normalizeLayout({ version: 1, columns: { a: { width: Number.NaN } } })).toEqual(emptyLayout());
  });
});

describe('visibleColumns', () => {
  it('removes hidden columns and moves pinned columns to the front in original order', () => {
    let layout = emptyLayout();
    layout = hideColumn(layout, 'email');
    layout = pinColumn(layout, 'name');
    layout = pinColumn(layout, 'id');

    const visible = visibleColumns(COLUMNS, layout);
    expect(visible.map((entry) => entry.column.name)).toEqual(['id', 'name']);
    expect(visible.map((entry) => entry.originalIndex)).toEqual([0, 2]);
    expect(visible.map((entry) => entry.pinned)).toEqual([true, true]);
  });

  it('keeps the original index stable after reordering and hiding', () => {
    let layout = pinColumn(emptyLayout(), 'name');
    layout = hideColumn(layout, 'id');
    const visible = visibleColumns(COLUMNS, layout);
    expect(visible.map((entry) => [entry.column.name, entry.originalIndex])).toEqual([
      ['name', 2],
      ['email', 1],
    ]);
  });

  it('carries explicit widths and clamps them', () => {
    const layout = setColumnWidth(emptyLayout(), 'email', 10);
    expect(visibleColumns(COLUMNS, layout)[1]?.width).toBe(MIN_COLUMN_WIDTH);
  });

  it('lists hidden columns', () => {
    const layout = hideColumn(hideColumn(emptyLayout(), 'email'), 'name');
    expect(hiddenColumns(COLUMNS, layout).map((column) => column.name)).toEqual(['email', 'name']);
  });
});

describe('layout requirements and widths', () => {
  it('requires a fixed layout only for pinned or explicitly sized columns', () => {
    expect(fixedLayoutRequired(visibleColumns(COLUMNS, emptyLayout()))).toBe(false);
    expect(fixedLayoutRequired(visibleColumns(COLUMNS, pinColumn(emptyLayout(), 'id')))).toBe(true);
    expect(fixedLayoutRequired(visibleColumns(COLUMNS, setColumnWidth(emptyLayout(), 'id', 200)))).toBe(true);
  });

  it('fills widths from explicit, measured and default values', () => {
    const layout = setColumnWidth(emptyLayout(), 'id', 200);
    const visible = visibleColumns(COLUMNS, layout);
    expect(filledWidths(visible, { email: 90, name: 10 })).toEqual([
      200,
      90,
      MIN_COLUMN_WIDTH,
    ]);
  });

  it('falls back to the default width when nothing was measured', () => {
    const visible = visibleColumns(COLUMNS, pinColumn(emptyLayout(), 'id'));
    expect(filledWidths(visible)).toEqual([DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH]);
  });

  it('accumulates sticky offsets only across pinned columns', () => {
    expect(stickyOffsets([100, 80, 120], [true, true, false])).toEqual([0, 100, null]);
    expect(stickyOffsets([100, 80], [false, true])).toEqual([null, 0]);
  });

  it('materializes widths without overriding explicit ones', () => {
    let layout = pinColumn(emptyLayout(), 'name');
    layout = setColumnWidth(layout, 'name', 120);
    const visible = visibleColumns(COLUMNS, layout);
    const next = materializeWidths(layout, visible, { name: 300, id: 40, email: 90 });

    expect(next.columns).toEqual({
      name: { pinned: true, width: 120 },
      id: { width: MIN_COLUMN_WIDTH },
      email: { width: 90 },
    });
  });
});

describe('prototype-like column names', () => {
  const raw = JSON.parse(
    '{"version":1,"columns":{"__proto__":{"hidden":true,"width":200},"constructor":{"pinned":true}}}',
  );

  it('normalizes __proto__ and constructor as ordinary column keys', () => {
    const layout = normalizeLayout(raw);
    expect(Object.getPrototypeOf(layout.columns)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(layout.columns, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(layout.columns, 'constructor')).toBe(true);
    expect(layout.columns['__proto__']).toEqual({ hidden: true, width: 200 });
    expect(isColumnHidden(layout, '__proto__')).toBe(true);
    expect(hiddenColumns([{ name: '__proto__' }, { name: 'id' }], layout).map((column) => column.name)).toEqual([
      '__proto__',
    ]);
    expect(visibleColumns([{ name: '__proto__' }, { name: 'id' }], layout).map((entry) => entry.column.name)).toEqual([
      'id',
    ]);
    expect(normalizeLayout(layout)).toEqual(layout);
  });

  it('updates and clears __proto__ without touching the prototype', () => {
    const layout = normalizeLayout(raw);
    const shown = showAllColumns(layout);
    expect(isColumnHidden(shown, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(shown.columns)).toBeNull();

    const pinned = pinColumn(layout, '__proto__');
    expect(pinned.columns['__proto__']).toEqual({ hidden: true, width: 200, pinned: true });
    expect(Object.getPrototypeOf(pinned.columns)).toBeNull();

    const reset = resetColumnWidth(layout, '__proto__');
    expect(reset.columns['__proto__']).toEqual({ hidden: true });
  });

  it('starts with a prototype-less column map', () => {
    expect(Object.getPrototypeOf(emptyLayout().columns)).toBeNull();
  });
});

describe('layout updates', () => {
  it('never mutates the input layout', () => {
    const base = emptyLayout();
    const next = hideColumn(base, 'id');
    expect(base).toEqual(emptyLayout());
    expect(next.columns.id).toEqual({ hidden: true });
  });

  it('keeps pinning when a column is hidden and shown again', () => {
    let layout = pinColumn(emptyLayout(), 'email');
    layout = hideColumn(layout, 'email');
    expect(isColumnHidden(layout, 'email')).toBe(true);

    const shown = showAllColumns(layout);
    expect(shown.columns.email).toEqual({ pinned: true });
  });

  it('removes empty preferences and whole empty layouts', () => {
    const hidden = hideColumn(emptyLayout(), 'id');
    const shown = hideColumn(hidden, 'id', false);
    expect(shown).toEqual(emptyLayout());
    expect(isLayoutEmpty(shown)).toBe(true);
  });

  it('resets a width without losing other preferences', () => {
    let layout = setColumnWidth(emptyLayout(), 'id', 240);
    layout = pinColumn(layout, 'id');
    expect(resetColumnWidth(layout, 'id').columns.id).toEqual({ pinned: true });
  });

  it('resets the whole layout and keeps setPref immutable', () => {
    const layout = setPref(pinColumn(emptyLayout(), 'id'), 'name', { hidden: true });
    expect(resetLayout()).toEqual(emptyLayout());
    expect(layout.columns).toEqual({ id: { pinned: true }, name: { hidden: true } });
  });
});
