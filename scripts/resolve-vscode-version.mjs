// Resolves the VS Code version the E2E job will run so the cache key and the
// launcher cannot disagree when stable moves.
//
// Set VSCODE_VERSION to pin a version (also useful for testing the minimum
// supported VS Code); otherwise the latest released stable is used.
const override = process.env.VSCODE_VERSION?.trim();
if (override && override !== 'stable') {
  console.log(override);
  process.exit(0);
}

const releases = 'https://update.code.visualstudio.com/api/releases/stable?released=true';

const response = await fetch(releases, {
  headers: { 'User-Agent': 'duckdb-viewer-ci' },
  signal: AbortSignal.timeout(30_000),
});

if (!response.ok) {
  throw new Error(`failed to resolve VS Code stable version: HTTP ${response.status}`);
}

const versions = await response.json();
const version = Array.isArray(versions) ? versions[0] : undefined;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`unexpected VS Code releases payload: ${JSON.stringify(versions).slice(0, 200)}`);
}

console.log(version);
