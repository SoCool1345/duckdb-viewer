import { runTests } from '@vscode/test-electron';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const executable = process.env.VSCODE_EXECUTABLE;

// The electron suite writes to the database, so give it a disposable copy.
const fixtureSource = path.join(root, '.tmp', 'fixtures', 'fixture.duckdb');
const fixture = path.join(root, '.tmp', 'integration', 'electron.duckdb');
fs.mkdirSync(path.dirname(fixture), { recursive: true });
fs.rmSync(fixture, { force: true });
fs.rmSync(`${fixture}.wal`, { force: true });
fs.copyFileSync(fixtureSource, fixture);

console.log(`[electron-test] vscode: ${executable ?? 'download stable'}`);

await runTests({
  ...(executable ? { vscodeExecutablePath: executable } : {}),
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'test', 'electron', 'suite', 'index.cjs'),
  launchArgs: [
    '--user-data-dir',
    path.join(root, '.tmp', 'vscode-profile'),
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    path.join(root, '.tmp', 'fixtures'),
  ],
  extensionTestsEnv: {
    DUCKDB_VIEWER_FIXTURE: fixture,
    DUCKDB_VIEWER_TEST: '1',
    ...(process.env.SCRUB_PATH
      ? {
          PATH: (process.env.PATH ?? '')
            .split(path.delimiter)
            .filter((entry) => !/nodejs|python|\.venv/i.test(entry))
            .join(path.delimiter),
        }
      : {}),
  },
});
