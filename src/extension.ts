import * as path from 'node:path';
import * as vscode from 'vscode';
import { DuckDbEditorProvider } from './host/editorProvider';
import type { ViewerRuntime } from './host/editorProvider';
import { HelperClient } from './host/rpcClient';
import { shouldShowStatus, statusLabel } from './host/status';
import type { DbSession } from './host/session';
import type { StatusResult } from './shared/protocol';

class Runtime implements ViewerRuntime {
  private client: HelperClient | undefined;
  private readonly sessions = new Set<DbSession>();
  private readonly busySessions = new Set<DbSession>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = 'duckdbViewer.showDiagnostics';
    this.statusItem.tooltip = 'DuckDB Viewer：点击查看锁诊断';
    this.output = vscode.window.createOutputChannel('DuckDB Viewer');
    context.subscriptions.push(this.statusItem, this.output);
  }

  acquireClient(): HelperClient {
    this.client ??= new HelperClient({
      helperPath: path.join(this.context.extensionPath, 'dist', 'helper.js'),
      onStderr: (line) => this.output.appendLine(line),
    });
    return this.client;
  }

  pageSize(): number {
    return vscode.workspace.getConfiguration('duckdbViewer').get<number>('pageSize', 100);
  }

  operationTimeoutMs(): number {
    return vscode.workspace.getConfiguration('duckdbViewer').get<number>('operationTimeoutMs', 20_000);
  }

  maxCellBytes(): number {
    return vscode.workspace.getConfiguration('duckdbViewer').get<number>('maxCellBytes', 4096);
  }

  registerSession(session: DbSession): void {
    this.sessions.add(session);
    this.updateStatus();
  }  unregisterSession(session: DbSession): void {
    this.sessions.delete(session);
    this.busySessions.delete(session);
    this.updateStatus();
  }

  publishBusy(session: DbSession, busy: boolean): void {
    if (busy) this.busySessions.add(session);
    else this.busySessions.delete(session);
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!shouldShowStatus(this.sessions.size)) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text = statusLabel(this.busySessions.size, this.sessions.size);
    this.statusItem.show();
  }

  async releaseLock(): Promise<void> {
    if (!this.client) {
      void vscode.window.showInformationMessage('当前没有打开的数据库句柄。');
      return;
    }
    await this.client.shutdown();
    for (const session of this.sessions) session.onHelperStopped();
    this.busySessions.clear();
    this.updateStatus();
    void vscode.window.showInformationMessage('已释放数据库锁（直接终止了助手进程）。');
  }

  async showDiagnostics(): Promise<void> {
    if (!this.client || !this.client.isRunning) {
      this.output.appendLine('openHandles: 0 (helper not running)');
      void vscode.window.showInformationMessage('当前打开的数据库句柄数：0（助手进程未运行）');
      return;
    }
    try {
      const status = await this.client.request<StatusResult>('status', undefined, 5000);
      this.output.appendLine(JSON.stringify(status, null, 2));
      const files = status.files.length > 0 ? `，文件：${status.files.join(', ')}` : '';
      void vscode.window.showInformationMessage(`当前打开的数据库句柄数：${status.openHandles}${files}`);
    } catch (error) {
      this.output.appendLine(String(error));
      void vscode.window.showWarningMessage(`无法读取诊断信息：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Test hook: returns the state of every open viewer. */
  debugSessions(): Array<{ dbPath: string; state: ReturnType<DbSession['snapshot']> }> {
    return [...this.sessions].map((session) => ({ dbPath: session.dbPath, state: session.snapshot() }));
  }

  refreshAll(): void {
    for (const session of this.sessions) session.handleMessage({ type: 'refresh' });
  }

  selectAll(selection: { schema: string; name: string; kind: 'table' | 'view' }): void {
    for (const session of this.sessions) session.handleMessage({ type: 'selectObject', ...selection });
  }

  async dispose(): Promise<void> {
    await this.client?.dispose();
  }
}

let runtime: Runtime | undefined;

export function activate(context: vscode.ExtensionContext): void {
  runtime = new Runtime(context);

  context.subscriptions.push(DuckDbEditorProvider.register(context, runtime));

  context.subscriptions.push(
    vscode.commands.registerCommand('duckdbViewer.openFile', async () => {
      const selection = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: '打开',
        filters: { 'DuckDB Database': ['duckdb', 'ddb'] },
      });
      const uri = selection?.[0];
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, DuckDbEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('duckdbViewer.openWith', async (resource?: vscode.Uri) => {
      const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showWarningMessage('请先选择一个 .duckdb 或 .ddb 文件。');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, DuckDbEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('duckdbViewer.releaseLock', async () => {
      await runtime?.releaseLock();
    }),

    vscode.commands.registerCommand('duckdbViewer.showDiagnostics', async () => {
      await runtime?.showDiagnostics();
    }),
  );

  // Test-only seam used by test/electron/suite to assert what the webview is
  // actually showing. Never registered in a normal user session.
  if (context.extensionMode === vscode.ExtensionMode.Test || process.env.DUCKDB_VIEWER_TEST === '1') {
    context.subscriptions.push(
      vscode.commands.registerCommand('duckdbViewer.__testControl', async (action?: string, payload?: unknown) => {
        if (action === 'refresh') runtime?.refreshAll();
        if (action === 'select' && payload) {
          runtime?.selectAll(payload as { schema: string; name: string; kind: 'table' | 'view' });
        }
        return runtime?.debugSessions() ?? [];
      }),
    );
  }
}

export async function deactivate(): Promise<void> {
  await runtime?.dispose();
  runtime = undefined;
}
