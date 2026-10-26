import type { ViewerState } from '../shared/messages';
import { searchSchema, type SearchHit } from '../shared/search';
import { createHandlers } from './handlers';
import { isComposingEvent, reconcileHighlight, type ColumnHighlight, type ObjectRef } from './interaction';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const handlers = createHandlers({ post: (message) => vscode.postMessage(message) });

let state: ViewerState | null = null;
let lastRenderKey = '';
const expandedObjects = new Set<string>();
const collapsedSchemas = new Set<string>();
let toastTimer: number | undefined;

let searchQuery = '';
let searchHits: SearchHit[] = [];
let searchTotal = 0;
let searchTruncated = false;
let activeHit = -1;
let highlight: ColumnHighlight | null = null;
let pendingJumps: ObjectRef[] = [];
let revealHighlight = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

function icon(kind: 'table' | 'view'): string {
  return kind === 'table' ? '▦' : '◧';
}

function objectKey(schema: string, name: string, kind: 'table' | 'view'): string {
  return `${schema}\u0000${name}\u0000${kind}`;
}

function renderTree(next: ViewerState): void {
  const tree = el<HTMLElement>('tree');
  tree.textContent = '';
  const shouldReveal = revealHighlight;
  revealHighlight = false;
  let highlightElement: HTMLElement | null = null;

  if (next.schemas.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tree-empty';
    empty.textContent = '该数据库中没有用户表或视图。';
    tree.appendChild(empty);
    return;
  }

  for (const group of next.schemas) {
    const schemaNode = document.createElement('div');
    schemaNode.className = 'tree-schema';

    const schemaRow = document.createElement('button');
    schemaRow.className = 'tree-row schema-row';
    schemaRow.type = 'button';
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = collapsedSchemas.has(group.name) ? '▸' : '▾';
    const label = document.createElement('span');
    label.textContent = group.name;
    schemaRow.append(twisty, label);
    schemaRow.addEventListener('click', () => {
      if (collapsedSchemas.has(group.name)) collapsedSchemas.delete(group.name);
      else collapsedSchemas.add(group.name);
      if (state) renderTree(state);
    });
    schemaNode.appendChild(schemaRow);

    if (!collapsedSchemas.has(group.name)) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      for (const object of group.objects) {
        const key = objectKey(group.name, object.name, object.kind);
        const row = document.createElement('div');
        row.className = 'tree-row object-row';
        if (next.selected?.schema === group.name && next.selected.name === object.name && next.selected.kind === object.kind) {
          row.classList.add('selected');
        }

        const expander = document.createElement('button');
        expander.type = 'button';
        expander.className = 'twisty-button';
        expander.textContent = expandedObjects.has(key) ? '▾' : '▸';
        expander.title = '显示列';
        expander.addEventListener('click', (event) => {
          event.stopPropagation();
          if (expandedObjects.has(key)) expandedObjects.delete(key);
          else expandedObjects.add(key);
          if (state) renderTree(state);
        });

        const name = document.createElement('span');
        name.className = 'object-name';
        name.textContent = `${icon(object.kind)} ${object.name}`;
        name.title = `${object.kind === 'table' ? '表' : '视图'} / ${group.name}`;
        name.addEventListener('click', () => {
          clearHighlight();
          handlers.selectObject({ schema: group.name, name: object.name, kind: object.kind });
        });

        row.append(expander, name);
        children.appendChild(row);

        if (expandedObjects.has(key)) {
          const columnList = document.createElement('div');
          columnList.className = 'column-list';
          for (const column of object.columns) {
            const line = document.createElement('div');
            line.className = 'column-row';
            if (
              highlight &&
              highlight.schema === group.name &&
              highlight.objectName === object.name &&
              highlight.objectKind === object.kind &&
              highlight.columnName === column.name
            ) {
              line.classList.add('highlight');
              highlightElement = line;
            }
            const columnName = document.createElement('span');
            columnName.textContent = column.name;
            const type = document.createElement('span');
            type.className = 'column-type';
            type.textContent = `${column.dataType}${column.nullable ? '' : ' NOT NULL'}`;
            line.append(columnName, type);
            if (column.default) line.title = `默认值: ${column.default}`;
            columnList.appendChild(line);
          }
          children.appendChild(columnList);
        }
      }
      schemaNode.appendChild(children);
    }
    tree.appendChild(schemaNode);
  }

  if (shouldReveal && highlightElement) {
    highlightElement.scrollIntoView({ block: 'nearest' });
  }
}

function renderFilter(next: ViewerState): void {
  const columnSelect = el<HTMLSelectElement>('filter-column');
  const current = columnSelect.value;
  const wanted = next.filter?.column ?? current;

  const options = next.columns.map((column) => column.name);
  const existing = Array.from(columnSelect.options).map((option) => option.value);
  const same = options.length === existing.length && options.every((name, index) => name === existing[index]);

  if (!same) {
    columnSelect.textContent = '';
    for (const name of options) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      columnSelect.appendChild(option);
    }
    if (options.includes(wanted)) columnSelect.value = wanted;
  }

  el<HTMLSelectElement>('filter-op').value = next.filter?.op ?? 'contains';
  const valueInput = el<HTMLInputElement>('filter-value');
  if (document.activeElement !== valueInput) {
    valueInput.value = next.filter?.value ?? '';
  }
  el<HTMLElement>('filter-box').classList.toggle('disabled', next.selected === null);
}

function renderGrid(next: ViewerState): void {
  const grid = el<HTMLTableElement>('grid');
  grid.textContent = '';
  const empty = el<HTMLElement>('empty');

  if (!next.selected) {
    empty.textContent = next.schemas.length === 0 ? '该数据库中没有用户表或视图。' : '从左侧选择一个表或视图。';
    empty.classList.remove('hidden');
    return;
  }

  if (next.rows.length === 0 && next.status === 'ready') {
    empty.textContent = next.filter ? '无匹配数据。' : '该对象当前没有数据。';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of next.columns) {
    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'column-header';
    const sorted = next.sort?.column === column.name ? next.sort.direction : null;
    button.textContent = `${column.name}${sorted ? (sorted === 'asc' ? ' ▲' : ' ▼') : ''}`;
    button.title = `${column.dataType} — 点击切换排序`;
    button.addEventListener('click', () => handlers.sort({ column: column.name }));
    th.appendChild(button);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  grid.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const [rowIndex, row] of next.rows.entries()) {
    const tr = document.createElement('tr');
    for (const [columnIndex, cell] of row.cells.entries()) {
      const td = document.createElement('td');
      if (cell === null) {
        td.textContent = 'NULL';
        td.className = 'null-cell';
      } else {
        td.textContent = cell;
      }
      if (row.truncated.includes(columnIndex)) {
        td.classList.add('truncated');
        td.title = '值已截断，双击查看完整内容';
        td.addEventListener('dblclick', () => handlers.requestFullCell({ rowIndex, columnIndex }));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  grid.appendChild(tbody);
}

function renderChrome(next: ViewerState): void {
  el<HTMLElement>('db-name').textContent = next.dbName;
  el<HTMLElement>('lock-state').textContent = next.busy ? '查询中（持有锁）' : '未占锁';
  el<HTMLElement>('lock-state').classList.toggle('busy', next.busy);
  el<HTMLElement>('progress').classList.toggle('hidden', !next.busy);
  el<HTMLElement>('cancel-op').classList.toggle('hidden', !next.busy);

  const banner = el<HTMLElement>('banner');
  if (next.banner) {
    banner.textContent = next.banner.text;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const errorPanel = el<HTMLElement>('error-panel');
  errorPanel.textContent = '';
  if (next.error) {
    errorPanel.classList.remove('hidden');
    const title = document.createElement('p');
    title.className = 'error-title';
    title.textContent = next.error.message;
    errorPanel.appendChild(title);
    if (next.error.hint) {
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = next.error.hint;
      errorPanel.appendChild(hint);
    }
    if (next.error.canRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => handlers.retryOpen());
      errorPanel.appendChild(retry);
    }
  } else if (next.lock) {
    errorPanel.classList.remove('hidden');
    const title = document.createElement('p');
    title.className = 'error-title';
    const owner = next.lock.processName
      ? `${next.lock.processName}${next.lock.pid !== undefined ? ` (PID ${next.lock.pid})` : ''}`
      : next.lock.pid !== undefined
        ? `PID ${next.lock.pid}`
        : '另一个进程';
    title.textContent = `数据库正被 ${owner} 以读写方式占用。`;
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'DuckDB 的写入进程要求独占文件。等待其结束后可自动继续。';
    errorPanel.append(title, hint);
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (next.lock.waiting) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = '取消等待';
      cancel.addEventListener('click', () => handlers.cancelWait());
      actions.appendChild(cancel);
    } else {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => handlers.retryOpen());
      const wait = document.createElement('button');
      wait.type = 'button';
      wait.className = 'secondary';
      wait.textContent = '等待释放';
      wait.addEventListener('click', () => handlers.waitForRelease());
      actions.append(retry, wait);
    }
    errorPanel.appendChild(actions);
  } else {
    errorPanel.classList.add('hidden');
  }

  const objectLabel = el<HTMLElement>('object-label');
  objectLabel.textContent = next.selected ? `${next.selected.schema}.${next.selected.name}` : '未选择对象';

  const rowCount = el<HTMLElement>('row-count');
  if (next.selected && next.estimatedRows !== null) {
    rowCount.textContent = `约 ${next.estimatedRows.toLocaleString()} 行（估算）`;
  } else if (next.selected) {
    rowCount.textContent = '行数未知';
  } else {
    rowCount.textContent = '';
  }

  el<HTMLButtonElement>('prev').disabled = !next.hasPrev || next.busy;
  el<HTMLButtonElement>('next').disabled = !next.hasMore || next.busy;
  el<HTMLElement>('page-info').textContent = next.selected ? `第 ${next.pageIndex + 1} 页` : '-';
  el<HTMLElement>('order-note').textContent = next.selected && !next.stableOrder ? '顺序不保证稳定' : '';
}

function openHit(hit: SearchHit): void {
  if (hit.kind === 'column') {
    highlight = { schema: hit.schema, objectName: hit.objectName, objectKind: hit.objectKind, columnName: hit.columnName };
    pendingJumps.push({ schema: hit.schema, objectName: hit.objectName, objectKind: hit.objectKind });
    expandedObjects.add(objectKey(hit.schema, hit.objectName, hit.objectKind));
    collapsedSchemas.delete(hit.schema);
    revealHighlight = true;
  } else {
    highlight = null;
    pendingJumps = [];
  }
  handlers.selectObject({ schema: hit.schema, name: hit.objectName, kind: hit.objectKind });
  if (state) renderTree(state);
}

function clearHighlight(): void {
  if (!highlight) return;
  highlight = null;
  pendingJumps = [];
  if (state) renderTree(state);
}

function clearSearch(): void {
  searchQuery = '';
  activeHit = -1;
  el<HTMLInputElement>('search-input').value = '';
  clearHighlight();
  renderSearch();
}

function ensureActiveVisible(): void {
  if (activeHit < 0) return;
  document.getElementById(`search-hit-${activeHit}`)?.scrollIntoView({ block: 'nearest' });
}

function renderSearch(): void {
  const input = el<HTMLInputElement>('search-input');
  const results = el<HTMLElement>('search-results');
  const clearButton = el<HTMLButtonElement>('search-clear');
  const summary = el<HTMLElement>('search-summary');
  const list = el<HTMLElement>('search-hits');

  const active = searchQuery.trim().length > 0;
  results.classList.toggle('hidden', !active);
  clearButton.classList.toggle('hidden', !active);
  input.setAttribute('aria-expanded', active ? 'true' : 'false');

  if (!active) {
    searchHits = [];
    searchTotal = 0;
    searchTruncated = false;
    activeHit = -1;
    summary.textContent = '';
    list.textContent = '';
    input.removeAttribute('aria-activedescendant');
    if (highlight) {
      highlight = null;
      pendingJumps = [];
      if (state) renderTree(state);
    }
    return;
  }

  const result = searchSchema(state?.schemas ?? [], searchQuery);
  searchHits = result.hits;
  searchTotal = result.total;
  searchTruncated = result.truncated;
  if (activeHit >= searchHits.length) activeHit = searchHits.length - 1;

  summary.textContent =
    searchTotal > 0 ? `${searchTotal.toLocaleString()} 条结果${searchTruncated ? '（仅显示前 200 条）' : ''}` : '';

  list.textContent = '';
  if (searchHits.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tree-empty';
    empty.textContent = '没有匹配的表、视图或列。';
    list.appendChild(empty);
    input.removeAttribute('aria-activedescendant');
    return;
  }

  for (const [index, hit] of searchHits.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-hit';
    button.id = `search-hit-${index}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === activeHit ? 'true' : 'false');
    if (index === activeHit) button.classList.add('active');

    const kind = document.createElement('span');
    kind.className = 'search-hit-kind';
    kind.textContent = hit.kind === 'object' ? (hit.objectKind === 'table' ? '表' : '视图') : '列';

    const name = document.createElement('span');
    name.className = 'search-hit-name';
    name.textContent = hit.kind === 'object' ? `${icon(hit.objectKind)} ${hit.objectName}` : hit.columnName;

    const meta = document.createElement('span');
    meta.className = 'search-hit-meta';
    meta.textContent = hit.kind === 'object' ? hit.schema : `${hit.dataType} · ${hit.schema}.${hit.objectName}`;

    button.append(kind, name, meta);
    button.addEventListener('click', () => openHit(hit));
    list.appendChild(button);
  }

  if (activeHit >= 0) input.setAttribute('aria-activedescendant', `search-hit-${activeHit}`);
  else input.removeAttribute('aria-activedescendant');
}

function render(next: ViewerState): void {
  state = next;
  ({ highlight, pendingJumps } = reconcileHighlight({ highlight, pendingJumps }, next.selected));
  renderChrome(next);
  renderFilter(next);
  renderGrid(next);
  renderTree(next);
  renderSearch();
}

function showToast(message: string, level: 'info' | 'error'): void {
  const toast = el<HTMLElement>('toast');
  toast.textContent = message;
  toast.className = `toast ${level}`;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.className = 'toast hidden';
  }, 4000);
}

function showCell(text: string | null, truncated: boolean): void {
  el<HTMLElement>('cell-text').textContent = text === null ? 'NULL' : text;
  el<HTMLElement>('cell-modal').classList.remove('hidden');
  if (truncated) showToast('该值仍然很大，展示的是前 1,000,000 个字符。', 'info');
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; state?: ViewerState; level?: 'info' | 'error'; message?: string; text?: string | null; truncated?: boolean };
  switch (data?.type) {
    case 'state':
      if (data.state) render(data.state);
      break;
    case 'toast':
      showToast(data.message ?? '', data.level === 'error' ? 'error' : 'info');
      break;
    case 'cellDetail':
      showCell(data.text ?? null, Boolean(data.truncated));
      break;
    default:
      break;
  }
});

el('refresh').addEventListener('click', () => handlers.refresh());
el('cancel-op').addEventListener('click', () => handlers.cancelOperation());
el('prev').addEventListener('click', () => handlers.prevPage());
el('next').addEventListener('click', () => handlers.nextPage());
el('filter-apply').addEventListener('click', () => {
  const column = el<HTMLSelectElement>('filter-column').value;
  const op = el<HTMLSelectElement>('filter-op').value as 'eq' | 'contains' | 'gt' | 'lt';
  const value = el<HTMLInputElement>('filter-value').value;
  if (!column) return;
  handlers.filter({ column, op, value });
});
el('filter-value').addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') el<HTMLButtonElement>('filter-apply').click();
});
el('filter-clear').addEventListener('click', () => handlers.clearFilter());
el('cell-close').addEventListener('click', () => el<HTMLElement>('cell-modal').classList.add('hidden'));
el('cell-modal').addEventListener('click', (event) => {
  if (event.target === el('cell-modal')) el<HTMLElement>('cell-modal').classList.add('hidden');
});

const searchInput = el<HTMLInputElement>('search-input');
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  activeHit = -1;
  renderSearch();
});
searchInput.addEventListener('keydown', (event) => {
  if (isComposingEvent(event)) return;
  if (event.key === 'Escape') {
    if (searchQuery.length === 0) return;
    event.preventDefault();
    clearSearch();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (searchHits.length === 0) return;
    event.preventDefault();
    activeHit = event.key === 'ArrowDown'
      ? Math.min(searchHits.length - 1, activeHit + 1)
      : Math.max(0, activeHit - 1);
    renderSearch();
    ensureActiveVisible();
    return;
  }
  if (event.key === 'Enter') {
    if (searchHits.length === 0) return;
    event.preventDefault();
    const hit = searchHits[activeHit >= 0 ? activeHit : 0];
    if (hit) openHit(hit);
  }
});
el('search-clear').addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

handlers.ready();
