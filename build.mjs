import esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';
fs.mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  minify: !watch,
};

const targets = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: `${outdir}/extension.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', '@duckdb/node-api'],
  },
  {
    ...common,
    entryPoints: ['src/helper/main.ts'],
    outfile: `${outdir}/helper.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['@duckdb/node-api'],
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: `${outdir}/webview.js`,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: false,
  },
];

function copyAssets() {
  fs.copyFileSync('src/webview/styles.css', `${outdir}/webview.css`);
}

if (watch) {
  const contexts = await Promise.all(targets.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  copyAssets();
  console.log('[build] watching...');
} else {
  await Promise.all(targets.map((options) => esbuild.build(options)));
  copyAssets();
  console.log('[build] done');
}
