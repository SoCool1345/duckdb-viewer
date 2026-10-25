import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WEBVIEW_MESSAGE_TYPES } from '../src/shared/messages';
import { createHandlers } from '../src/webview/handlers';

describe('webview message contract', () => {
  it('implements exactly the declared webview message types', () => {
    const handlers = createHandlers({ post: () => undefined });
    expect(Object.keys(handlers).sort()).toEqual([...WEBVIEW_MESSAGE_TYPES].sort());
  });

  it('documents every webview message type', () => {
    const doc = readFileSync('docs/ui-contract.md', 'utf8');
    for (const type of WEBVIEW_MESSAGE_TYPES) {
      expect(doc).toContain(type);
    }
  });

  it('posts the expected payload for a selection', () => {
    const posted: unknown[] = [];
    const handlers = createHandlers({ post: (message) => posted.push(message) });
    handlers.selectObject({ schema: 'main', name: 'users', kind: 'table' });
    expect(posted).toEqual([{ type: 'selectObject', schema: 'main', name: 'users', kind: 'table' }]);
  });

  it('coerces numeric cell coordinates', () => {
    const posted: unknown[] = [];
    const handlers = createHandlers({ post: (message) => posted.push(message) });
    handlers.requestFullCell({ rowIndex: '2', columnIndex: 3 });
    expect(posted).toEqual([{ type: 'requestFullCell', rowIndex: 2, columnIndex: 3 }]);
  });
});
