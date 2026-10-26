import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ViewerState } from '../shared/messages';
import type { ColumnLayoutStore } from './columnLayoutStore';
import { HelperClient } from './rpcClient';
import { DbSession } from './session';
import { renderHtml } from './webviewHtml';

export interface ViewerRuntime {
  acquireClient(): HelperClient;
  pageSize(): number;
  operationTimeoutMs(): number;
  maxCellBytes(): number;
  columnLayouts(): ColumnLayoutStore;
  registerSession(session: DbSession): void;
  unregisterSession(session: DbSession): void;
  publishBusy(session: DbSession, busy: boolean): void;
}

class DuckDbDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    // Read-only document: nothing to clean up here.
  }
}

export class DuckDbEditorProvider implements vscode.CustomReadonlyEditorProvider<DuckDbDocument> {
  static readonly viewType = 'duckdbViewer.database';

  static register(context: vscode.ExtensionContext, runtime: ViewerRuntime): vscode.Disposable {
    const provider = new DuckDbEditorProvider(context, runtime);
    return vscode.window.registerCustomEditorProvider(DuckDbEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: ViewerRuntime,
  ) {}

  openCustomDocument(uri: vscode.Uri): DuckDbDocument {
    return new DuckDbDocument(uri);
  }

  resolveCustomEditor(document: DuckDbDocument, panel: vscode.WebviewPanel): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    panel.webview.html = renderHtml(panel.webview, mediaRoot);
    panel.title = `${path.basename(document.uri.fsPath)} (只读)`;

    const session = new DbSession({
      dbPath: document.uri.fsPath,
      dbName: path.basename(document.uri.fsPath),
      client: this.runtime.acquireClient(),
      pageSize: this.runtime.pageSize(),
      operationTimeoutMs: this.runtime.operationTimeoutMs(),
      maxCellBytes: this.runtime.maxCellBytes(),
      columnLayouts: this.runtime.columnLayouts(),
      onState: (state: ViewerState) => {
        void panel.webview.postMessage({ type: 'state', state });
      },
      onBusyChange: (busy: boolean) => this.runtime.publishBusy(session, busy),
      onCellDetail: (text: string | null, truncated: boolean) => {
        void panel.webview.postMessage({ type: 'cellDetail', text, truncated });
      },
      onToast: (level: 'info' | 'error', message: string) => {
        void panel.webview.postMessage({ type: 'toast', level, message });
      },
    });

    this.runtime.registerSession(session);
    const subscription = panel.webview.onDidReceiveMessage((message: unknown) => session.handleMessage(message));
    session.start();

    panel.onDidDispose(() => {
      subscription.dispose();
      session.dispose();
      this.runtime.unregisterSession(session);
    });
  }
}
