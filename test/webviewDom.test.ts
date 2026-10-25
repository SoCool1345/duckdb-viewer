import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('src/host/webviewHtml.ts', 'utf8');
const main = readFileSync('src/webview/main.ts', 'utf8');

function idsInHtml(): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1] as string));
}

function idsUsedByScript(): Set<string> {
  return new Set([...main.matchAll(/\bel(?:<[^>]+>)?\('([^']+)'\)/g)].map((match) => match[1] as string));
}

describe('webview DOM contract', () => {
  it('only queries element ids that exist in the rendered HTML', () => {
    const available = idsInHtml();
    const used = idsUsedByScript();
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((id) => !available.has(id));
    expect(missing).toEqual([]);
  });

  it('serves the webview bundle and stylesheet that the build produces', () => {
    expect(html).toContain("'webview.js'");
    expect(html).toContain("'webview.css'");
  });
});
