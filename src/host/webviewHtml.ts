import * as vscode from 'vscode';

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let index = 0; index < 32; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}

export function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css'));
  const token = nonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${token}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>DuckDB Viewer</title>
</head>
<body>
  <div id="app">
    <header id="titlebar">
      <span id="db-name"></span>
      <span class="badge">只读</span>
      <span id="lock-state" class="lock-state"></span>
      <span class="spacer"></span>
      <button id="cancel-op" class="secondary hidden" title="中断当前查询并释放数据库句柄">取消</button>
      <button id="refresh" class="secondary" title="重新读取 schema 与当前页">刷新</button>
    </header>
    <div id="progress" class="progress hidden"><div class="bar"></div></div>
    <div id="banner" class="banner hidden"></div>
    <div id="error-panel" class="error-panel hidden"></div>
    <div id="body">
      <aside id="sidebar" class="sidebar">
        <div class="search-box">
          <input id="search-input" type="text" role="combobox" placeholder="搜索表、视图或列" autocomplete="off" spellcheck="false" aria-label="搜索表、视图或列" aria-autocomplete="list" aria-controls="search-hits" aria-expanded="false" />
          <button id="search-clear" class="secondary search-clear hidden" title="清空搜索" aria-label="清空搜索">×</button>
        </div>
        <div id="search-results" class="search-results hidden">
          <div id="search-summary" class="search-summary muted" aria-live="polite"></div>
          <div id="search-hits" class="search-hits" role="listbox" aria-label="搜索结果"></div>
        </div>
        <aside id="tree" class="tree"></aside>
      </aside>
      <section id="content">
        <div id="toolbar" class="toolbar">
          <span id="object-label" class="object-label">未选择对象</span>
          <span id="row-count" class="muted"></span>
          <span class="spacer"></span>
          <div id="filter-box" class="filter-box">
            <select id="filter-column" title="过滤列"></select>
            <select id="filter-op" title="过滤方式">
              <option value="contains">包含</option>
              <option value="eq">等于</option>
              <option value="gt">大于</option>
              <option value="lt">小于</option>
            </select>
            <input id="filter-value" type="text" placeholder="过滤值" />
            <button id="filter-apply">应用</button>
            <button id="filter-clear" class="secondary">清除</button>
          </div>
        </div>
        <div id="grid-wrap" class="grid-wrap">
          <table id="grid"></table>
          <div id="empty" class="empty hidden"></div>
        </div>
        <footer id="pager" class="pager">
          <button id="prev" class="secondary">上一页</button>
          <span id="page-info">-</span>
          <button id="next" class="secondary">下一页</button>
          <span id="order-note" class="muted"></span>
        </footer>
      </section>
    </div>
    <div id="cell-modal" class="modal hidden">
      <div class="modal-body">
        <header><span>完整值</span><span class="spacer"></span><button id="cell-close" class="secondary">关闭</button></header>
        <pre id="cell-text"></pre>
      </div>
    </div>
    <div id="toast" class="toast hidden"></div>
  </div>
  <script nonce="${token}" src="${scriptUri}"></script>
</body>
</html>`;
}
