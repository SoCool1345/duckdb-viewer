import { normalizeLayout } from '../shared/columnLayout';
import type { WebviewMessage, WebviewMessageType } from '../shared/messages';

export interface WebviewApi {
  post(message: WebviewMessage): void;
}

type Handler = (message?: any) => void;

/**
 * The single entry point for messages coming from the extension host.
 * Tests assert that its keys match WEBVIEW_MESSAGE_TYPES exactly, so the
 * documented contract cannot drift from the implementation.
 */
export function createHandlers(api: WebviewApi): Record<WebviewMessageType, Handler> {
  return {
    ready: () => api.post({ type: 'ready' }),
    selectObject: (message) =>
      api.post({ type: 'selectObject', schema: String(message.schema), name: String(message.name), kind: message.kind === 'view' ? 'view' : 'table' }),
    sort: (message) => api.post({ type: 'sort', column: String(message.column) }),
    filter: (message) =>
      api.post({ type: 'filter', column: String(message.column), op: message.op, value: String(message.value) }),
    clearFilter: () => api.post({ type: 'clearFilter' }),
    setColumnLayout: (message) =>
      api.post({
        type: 'setColumnLayout',
        schema: String(message.schema),
        name: String(message.name),
        kind: message.kind === 'view' ? 'view' : 'table',
        layout: normalizeLayout(message.layout),
      }),
    nextPage: () => api.post({ type: 'nextPage' }),
    prevPage: () => api.post({ type: 'prevPage' }),
    refresh: () => api.post({ type: 'refresh' }),
    requestFullCell: (message) =>
      api.post({ type: 'requestFullCell', rowIndex: Number(message.rowIndex), columnIndex: Number(message.columnIndex) }),
    retryOpen: () => api.post({ type: 'retryOpen' }),
    waitForRelease: () => api.post({ type: 'waitForRelease' }),
    cancelOperation: () => api.post({ type: 'cancelOperation' }),
    cancelWait: () => api.post({ type: 'cancelWait' }),
  };
}
