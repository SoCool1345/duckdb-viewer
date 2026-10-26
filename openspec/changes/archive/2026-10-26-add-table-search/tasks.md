# Tasks

## 1. 共享搜索逻辑

- [x] 1.1 新增 `src/shared/search.ts`：实现 `searchSchema(schemas, query, limit = 200)`，返回命中列表、匹配总数与截断标志；按 design D1 处理分词、对象/列匹配条件以及"完全 > 前缀 > 子串、对象先于列"的排序。验证：`npm run typecheck` 通过。
- [x] 1.2 新增 `test/search.test.ts`，覆盖大小写不敏感、多词 AND、列名命中、表名命中时不展开无关列、排序与并列规则、200 条上限与总数、空查询。验证：`npm run test:unit -- test/search.test.ts` 全部通过。

## 2. Webview 侧栏 UI

- [x] 2.1 调整 `src/host/webviewHtml.ts` 为 `#sidebar` 结构（搜索框、`#search-results`、`#tree`），并在 `src/webview/styles.css` 增加主题变量样式：搜索框满宽、活动结果、列高亮、结果摘要与空状态。验证：`npm run compile` 成功，且 `npm run test:unit -- test/webviewHtml.test.ts test/webviewDom.test.ts` 通过。
- [x] 2.2 在 `src/webview/main.ts` 接入搜索：输入即调用 `searchSchema`，渲染结果摘要、空状态与截断提示；查询非空时在树上方显示结果区（树保持可见，列跳转需要它），清空或 Esc 后结果区隐藏；实现 ↑/↓/Enter/Esc 与 `aria-activedescendant` 活动项。验证：`npm run compile` 通过，并在 Extension Development Host 中逐条走通 spec 的搜索场景。
- [x] 2.3 实现列结果跳转：选中所属对象、展开对应节点、滚动到并高亮该列；在切换对象、清空搜索或关闭结果面板时清除高亮。验证：在 `.tmp/fixtures/fixture.duckdb` 中搜索列名并点击列结果，确认数据页加载、列可见且高亮。
- [x] 2.4 更新 `README.md` 功能列表，加入"按名称搜索表/视图/列并跳转"。验证：README 描述与手工观察到的行为一致。

## 3. 集成验证

- [x] 3.1 运行 `npm run verify`，确认 typecheck、构建、fixtures、单元/协议测试与锁不变量集成测试全部通过。
- [x] 3.2 运行 `npm run test:electron`（必要时用 `VSCODE_EXECUTABLE` 指定本机 VS Code）完成冒烟：打开 fixture、搜索并跳转列，且外部进程仍能在查看器空闲时写入数据库；记录结果。
  - 结果：Electron 套件通过（schema、网格、外部写入均验证）；该套件不驱动 webview DOM，搜索/列跳转改用临时无头 Edge 页面加载 `dist/webview.js` 验证（输入不产生消息、表名命中不列出列、↑/Enter 打开、列高亮、切换对象清除高亮、Esc 清空）。
  - 从 VS Code 终端启动时需 `env -u ELECTRON_RUN_AS_NODE`，否则 `Code.exe` 会以 Node 模式拒绝 `--user-data-dir`。
