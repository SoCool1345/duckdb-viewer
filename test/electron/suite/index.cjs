const assert = require('node:assert');
const path = require('node:path');
const vscode = require('vscode');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = 'none';
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    lastObservation = describeLast();
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}; last observation: ${lastObservation}`);
}

let describeLast = () => 'none';

/**
 * Runs inside a real VS Code extension host. Asserts not just that a tab
 * exists, but that the schema and grid actually loaded, and that an external
 * writer can modify the database while the viewer is open.
 */
async function run() {
  const extension = vscode.extensions.getExtension('local.duckdb-viewer');
  assert.ok(extension, 'DuckDB Viewer extension should be discoverable');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    'duckdbViewer.openFile',
    'duckdbViewer.openWith',
    'duckdbViewer.releaseLock',
    'duckdbViewer.showDiagnostics',
  ]) {
    assert.ok(commands.includes(id), `command ${id} should be registered`);
  }
  console.log(
    '[electron-test] test control:',
    commands.includes('duckdbViewer.__testControl'),
    'env:',
    process.env.DUCKDB_VIEWER_TEST,
  );

  const fixture = process.env.DUCKDB_VIEWER_FIXTURE;
  assert.ok(fixture, 'DUCKDB_VIEWER_FIXTURE must be provided');
  const dbPath = path.resolve(fixture);

  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(dbPath), 'duckdbViewer.database');

  const readSession = async () => {
    const sessions = await vscode.commands.executeCommand('duckdbViewer.__testControl', 'state');
    describeLast = () =>
      JSON.stringify(
        Array.isArray(sessions)
          ? sessions.map((candidate) => ({
              dbPath: candidate.dbPath,
              status: candidate.state?.status,
              busy: candidate.state?.busy,
              schemas: candidate.state?.schemas?.length ?? 0,
              rows: candidate.state?.rows?.length ?? 0,
              selected: candidate.state?.selected,
              columnLayout: candidate.state?.columnLayout,
              error: candidate.state?.error?.message,
              lock: candidate.state?.lock,
            }))
          : sessions,
      );
    return Array.isArray(sessions)
      ? sessions.find((candidate) => candidate.dbPath.toLowerCase() === dbPath.toLowerCase())
      : undefined;
  };

  const loaded = await poll(async () => {
    const session = await readSession();
    if (!session) return undefined;
    return session.state.status === 'ready' && session.state.rows.length > 0 && session.state.busy === false
      ? session
      : undefined;
  }, 20_000, 'the viewer to load a page');

  assert.strictEqual(loaded.state.busy, false, 'viewer should be idle after loading');
  assert.ok(loaded.state.selected, 'a table should be selected');

  const main = loaded.state.schemas.find((group) => group.name === 'main');
  assert.ok(main, 'schema "main" should be listed');
  const users = main.objects.find((object) => object.name === 'users');
  assert.ok(users, 'table "users" should be listed');
  assert.ok(
    users.columns.some((column) => column.name === 'name' && column.dataType === 'VARCHAR'),
    'column metadata should be loaded',
  );

  // Same path the schema tree uses when the user clicks a table.
  await vscode.commands.executeCommand('duckdbViewer.__testControl', 'select', {
    schema: 'main',
    name: 'users',
    kind: 'table',
  });

  const showingUsers = await poll(async () => {
    const session = await readSession();
    if (!session) return undefined;
    const state = session.state;
    return state.selected?.name === 'users' && state.rows.some((row) => row.cells.includes('alice')) && !state.busy
      ? session
      : undefined;
  }, 15_000, 'the users table to be displayed');

  const tab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((candidate) => candidate.input && candidate.input.viewType === 'duckdbViewer.database');
  assert.ok(tab, 'a duckdbViewer.database tab should be open');

  assert.ok(
    showingUsers.state.rows.some((row) => row.cells.includes('alice')),
    'the grid should contain fixture data',
  );

  // Write through a second DuckDB instance in this process. If the viewer were
  // holding a lock at rest, this would fail with a LOCKED error.
  const { DuckDBInstance } = require(path.join(extension.extensionPath, 'node_modules', '@duckdb/node-api'));
  const writerInstance = await DuckDBInstance.create(dbPath);
  const writerConnection = await writerInstance.connect();
  try {
    await writerConnection.run(`insert into users (id, name) values (9001, 'written-while-open')`);
  } finally {
    writerConnection.closeSync();
    writerInstance.closeSync();
  }

  await vscode.commands.executeCommand('duckdbViewer.__testControl', 'refresh');

  const refreshed = await poll(async () => {
    const session = await readSession();
    if (!session) return undefined;
    return session.state.rows.some((row) => row.cells.includes('written-while-open')) && session.state.busy === false
      ? session
      : undefined;
  }, 15_000, 'the externally written row to appear');

  assert.strictEqual(refreshed.state.busy, false);
  assert.strictEqual(refreshed.state.error, null);

  // Column layout: save it for `users`, close the tab, reopen it, and make
  // sure the host restores the same layout from global state.
  await vscode.commands.executeCommand('duckdbViewer.__testControl', 'layout', {
    schema: 'main',
    name: 'users',
    kind: 'table',
    layout: {
      version: 1,
      columns: { id: { width: 240, pinned: true }, name: { hidden: true } },
    },
  });

  const laidOut = await poll(async () => {
    const session = await readSession();
    if (!session) return undefined;
    const layout = session.state.columnLayout;
    return (
      layout &&
      layout.columns.id?.width === 240 &&
      layout.columns.id?.pinned === true &&
      layout.columns.name?.hidden === true
    )
      ? session
      : undefined;
  }, 10_000, 'the column layout to be saved');
  assert.strictEqual(laidOut.state.busy, false);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await delay(500);

  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(dbPath), 'duckdbViewer.database');
  await poll(async () => {
    const session = await readSession();
    return session && session.state.status === 'ready' ? session : undefined;
  }, 20_000, 'the reopened tab to load');

  // The viewer may auto-select another object first; re-open the same object
  // the layout was saved for, as a user would after reopening the tab.
  await vscode.commands.executeCommand('duckdbViewer.__testControl', 'select', {
    schema: 'main',
    name: 'users',
    kind: 'table',
  });
  const reopened = await poll(async () => {
    const session = await readSession();
    if (!session) return undefined;
    const layout = session.state.columnLayout;
    return (
      session.state.selected?.name === 'users' &&
      session.state.status === 'ready' &&
      session.state.rows.length > 0 &&
      session.state.busy === false &&
      layout &&
      layout.columns.id?.width === 240 &&
      layout.columns.id?.pinned === true &&
      layout.columns.name?.hidden === true
    )
      ? session
      : undefined;
  }, 20_000, 'the saved column layout to be restored after reopening the tab');
  assert.ok(reopened, 'column layout should survive closing and reopening the tab');

  // Leave the shared test profile with the default layout for the next run.
  // (VS Code keeps extension storage in memory during extension tests, so this
  // reset is mostly defensive; real restarts persist globalState on disk.)
  await vscode.commands.executeCommand('duckdbViewer.__testControl', 'layout', {
    schema: 'main',
    name: 'users',
    kind: 'table',
    layout: { version: 1, columns: {} },
  });

  await vscode.commands.executeCommand('duckdbViewer.releaseLock');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  console.log('[electron-test] schema, grid, external write and column layout persistence verified');
}

exports.run = run;
