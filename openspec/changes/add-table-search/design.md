# Design

## Context

搜索建立在现有结构上，不改变数据访问路径：

- `listSchema` 已一次性把全部 schema、表、视图、列读入 `ViewerState.schemas`（见现有设计 D8），展开树不连库。
- Webview 是无框架的原生 TS + DOM，宿主每次状态变化推送完整 `ViewerState`；webview → 宿主消息由 `WEBVIEW_MESSAGE_TYPES` 与 `createHandlers` 的键集合严格约束。
- 搜索不需要新的宿主交互：查询与结果都在 webview 内计算，跳转复用现有的对象选择消息。

约束：任何新交互都不得读取数据库、不得让界面显示"查询中（持有锁）"，否则会与现有的"静止时零句柄"不变量冲突。

## Goals / Non-Goals

**Goals:**

- 搜索在 schema 元数据加载后即时可用，零数据库访问、零 RPC、零新消息。
- 匹配与排序逻辑可被纯函数单测覆盖，DOM 层保持薄。
- 搜索结果能直接跳转到具体列，并让该列在树中可见。

**Non-Goals:**

- 不做数据值搜索、SQL 搜索或跨库聚合搜索。
- 不做模糊/拼音/首字母匹配，也不做搜索历史。
- 不做收藏；不改 JSON-RPC、助手进程或数据库访问代码。

## Decisions

### D1. 搜索是 webview 内的纯内存计算，核心逻辑放 `src/shared/search.ts`

输入 `ViewerState.schemas` 与查询串，输出结果列表、匹配总数与截断标志。纯函数、无 DOM、无 vscode 依赖，直接由 vitest 覆盖。

匹配规则：

1. 查询 `trim()` 后按 `/\s+/` 分词并转小写；空查询视为"未搜索"。
2. 对象：限定名 `schema.name` 的小写形式必须包含**所有**词。
3. 列：限定路径 `schema.name.column` 必须包含所有词，**且**至少一个词出现在列名本身中。这样搜索表名不会把整表所有列倒出来。
4. 排序键：叶子名称（对象名或列名）与查询词的匹配质量——完全相等（0）< 前缀（1）< 子串（2）< 仅 schema/表名命中（3）；同质量下对象在列之前，再按 schema、叶子名称、列序号排序。
5. 最多返回 200 条，同时返回匹配总数供界面提示。

替代方案：把搜索下推到宿主、用 DuckDB 目录查询——否决。元数据已在内存，走 RPC 只会增加延迟与占锁窗口，且数据库被占用时搜索会不可用。

每次按键重建小写字符串的成本在万级列规模下仍可忽略，因此不引入索引缓存与防抖；这保持实现简单，也避免缓存失效问题。

### D2. 侧栏结构：搜索框 + 结果区 + schema 树

`webviewHtml.ts` 把原来的 `#tree` 包进 `#sidebar`：

```
aside#sidebar
  div.search-box   -> input#search-input, button#search-clear
  div.search-results.hidden -> #search-summary, #search-hits
  aside#tree                -> 现有 schema 树
```

- 查询非空时在树上方显示结果区，`#tree` **保持可见**：spec 要求列跳转后该列在树中被展开、高亮并滚动到可见区域，隐藏树就无法满足。结果区有最大高度并可独立滚动；清空或 Esc 后结果区隐藏，树占满侧栏。搜索不改变 `ViewerState`，因此不触发宿主往返。
- 搜索结果都是 `<button>`；对象结果标注 schema 与类型，列结果标注 `列名 · 类型 · schema.表名`。
- 搜索的渲染只重绘结果区，不重绘网格，避免打断当前数据页。

### D3. 键盘操作与列跳转

- 键盘：输入框内 ↑/↓ 移动 `activeIndex`，Enter 打开活动项（无活动项时打开第一条），Esc 清空。活动项加 `.active` 类，并用 `aria-activedescendant` 指向结果元素。
- 对象结果：走现有的对象选择路径，选中并加载第一页，排序与过滤按现有规则重置。
- 列跳转：点击列结果后记录 `{schema, object, column}`；从 `ViewerState` 选中该对象，把对象键加入 `expandedObjects`、从 `collapsedSchemas` 移除，然后在渲染后对 `.column-row.highlight` 调用 `scrollIntoView({ block: 'nearest' })`。对象键沿用现有格式 `${group.name}\u0000${object.name}\u0000${object.kind}`。
- 用户在树或结果中切换到别的对象、清空搜索或关闭结果面板时清除高亮。

### D4. 搜索结果的视觉呈现

- 搜索摘要显示 `N 条结果`，截断时追加"仅显示前 200 条"；无匹配使用与现有空状态一致的 `.tree-empty` 样式。
- 活动结果使用 `--vscode-list-activeSelectionBackground`，列高亮使用 `--vscode-list-inactiveSelectionBackground`，避免与当前对象的选中色混淆。
- 搜索框宽度覆盖全局 `input[type='text'] { width: 140px }`，在侧栏内占满；新增样式全部使用 VS Code 主题变量。

### D5. 测试策略

- `test/search.test.ts`：大小写、多词 AND、列名命中规则、表名命中不展开列、排序（完全 > 前缀 > 子串，对象先于列）、200 条上限与总数、空查询。
- 现有 `test/webviewDom.test.ts` 自动校验新 `el()` 使用的 id 都出现在 HTML。
- 手工/Electron 冒烟：打开 fixture → 搜索 `users` 与 `name` → 点击列结果确认高亮。

## Risks / Trade-offs

- **搜索只在 schema 已加载时有内容**：数据库被占用或首次加载中，搜索框可用但结果为空。→ 空状态文案沿用"该数据库中没有用户表或视图"或"尚未加载 schema"，不额外发起请求。
- **每键重建小写字符串**：超大 schema（数万列）下可能有轻微输入延迟。→ 现有元数据一次性加载且 200 条上限，实测规模可接受；若将来成为瓶颈，再在 `searchSchema` 外包一层按 `schemas` 引用缓存的索引，不改变契约。
- **结果区挤占树的高度**：结果较多时树的可视区域变小。→ 结果区限制最大高度并独立滚动，且只在查询非空时出现。
- **高亮依赖本地 UI 状态**：刷新、切换对象或重新渲染后不再保留。→ spec 只要求跳转时可见，刷新不承诺保留。

## Migration Plan

纯新增 UI，无数据迁移。

1. 先落地纯函数 `search.ts` 与单测。
2. 调整侧栏 HTML/CSS，接入搜索交互与列跳转。
3. 跑 `npm run verify`，再做 Extension Development Host 手工冒烟。

回滚：移除侧栏搜索控件与相关样式即可，不影响任何既有状态或存储。

## Verification

- `npm run typecheck`、`npm run compile`、`npm run test:unit` 全绿。
- 新增单测覆盖 D1 的匹配、排序与上限规则。
- Electron 冒烟确认：打开数据库后搜索、跳转列，数据库始终可被外部进程写入（验证未引入额外占锁）。
