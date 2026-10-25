import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Webview } from 'vscode';
import { renderHtml } from '../src/host/webviewHtml';

const webview = {
  cspSource: 'vscode-resource://test',
  asWebviewUri: (uri: unknown) => `vscode-resource://test/${(uri as { path: string }).path}`,
} as unknown as Webview;

const html = renderHtml(webview, { path: '/extension' } as never);

describe('webview shell', () => {
  it('locks the page down with a nonce-based CSP', () => {
    expect(html).toContain("default-src 'none'");
    const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${String(nonce)}"`);
    expect(html).not.toContain("script-src 'unsafe-inline'");
  });

  it('loads the built bundle and stylesheet relative to the extension', () => {
    expect(html).toContain('webview.js');
    expect(html).toContain('webview.css');
    expect(html).toContain(path.sep === '\\' ? '/extension/webview.js' : '/extension/webview.js');
  });

  it('renders the empty shell before any state arrives', () => {
    expect(html).toContain('id="tree"');
    expect(html).toContain('id="grid"');
    expect(html).toContain('id="pager"');
    expect(html).toContain('只读');
  });
});
