import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  main: string;
  contributes: {
    customEditors: Array<{ viewType: string; selector: Array<{ filenamePattern: string }>; priority: string }>;
    commands: Array<{ command: string; title: string }>;
    menus: { 'explorer/context': Array<{ command: string; when: string }> };
  };
};

describe('extension manifest', () => {
  it('registers a non-default custom editor for both extensions', () => {
    const editor = manifest.contributes.customEditors.find((entry) => entry.viewType === 'duckdbViewer.database');
    expect(editor).toBeDefined();
    expect(editor?.priority).toBe('option');
    const patterns = editor?.selector.map((entry) => entry.filenamePattern) ?? [];
    expect(patterns).toContain('*.duckdb');
    expect(patterns).toContain('*.ddb');
  });

  it('contributes the commands that the extension registers', () => {
    const ids = manifest.contributes.commands.map((entry) => entry.command);
    expect(ids).toEqual(
      expect.arrayContaining([
        'duckdbViewer.openFile',
        'duckdbViewer.openWith',
        'duckdbViewer.releaseLock',
        'duckdbViewer.showDiagnostics',
      ]),
    );
  });

  it('adds an explorer context menu entry limited to DuckDB files', () => {
    const entry = manifest.contributes.menus['explorer/context'].find(
      (item) => item.command === 'duckdbViewer.openWith',
    );
    expect(entry?.when).toContain('resourceExtname == .duckdb');
    expect(entry?.when).toContain('resourceExtname == .ddb');
  });

  it('points at the built extension entry', () => {
    expect(manifest.main).toBe('./dist/extension.js');
  });
});
