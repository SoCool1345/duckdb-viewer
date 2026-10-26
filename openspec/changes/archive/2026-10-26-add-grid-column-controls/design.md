# Design

## Context

现有网格是 webview 内的原生 `<table>`：`renderGrid` 直接遍历 `ViewerState.columns` 与 `rows`，列索引与数据行一一对应；排序、过滤、截断列与 `requestFullCell` 都以原始列索引为准（见 `src/webview/main.ts`、`src/host/session.ts`）。

约束：

- 宿主每次推送完整 `ViewerState`，webview 的 `main.ts` 没有状态容器，所有交互都落在 DOM 与消息上。
- webview → 宿主消息由 `WEBVIEW_MESSAGE_TYPES`、`createHandlers` 与 `docs/ui-contract.md` 三方约束，`test/uiContract.test.ts` 会断言一致。
- 静止时零数据库句柄是锁安全不变量；列布局属于显示层，只有"隐藏当前排序列"需要清除排序，因而会复用现有的重新取页路径。
- 列设置在关闭标签页或重启编辑器后仍要恢复，因此不能只放在 webview 内存里。

## Goals / Non-Goals

**Goals:**

- 列宽、隐藏、固定、粘性偏移与设置合并逻辑做成无 DOM 的纯函数，便于单测。
- 列布局由宿主持有并持久化，webview 只负责渲染和发起变更；刷新、切换对象、重开标签页都走同一条恢复路径。
- 隐藏列不改变数据行与列索引，避免影响 `rows[].truncated`、`requestFullCell` 与现有排序/过滤契约。
- 固定列只做左侧粘性定位，不引入列拖拽重排。

**Non-Goals:**

- 不按可见列裁剪查询、不改 JSON-RPC 与助手进程。
- 不做列拖拽重排、固定到右侧、列虚拟化或服务端布局同步。
- 不改变默认的"自动按内容定宽"外观，除非用户主动调宽或固定列。

## Decisions

### D1. 列设置模型与纯函数放 `src/shared/columnLayout.ts`

```ts
interface ColumnPref {
  width?: number;   // CSS px，已 clamp
  hidden?: boolean;
  pinned?: boolean;
}
interface ColumnLayout {
  version: 1;
  columns: Record<string, ColumnPref>; // key = 列名
}
```

- `normalizeLayout(raw)`：容错解析持久化数据。丢弃非对象、未知版本、非法宽度与非法字段；宽度 clamp 到 `[60, 2000]`；删除空 pref 与空对象。持久化数据永远先经过它，webview 传入的数据也一样处理。
- `visibleColumns(columns, layout)`：保持原始列顺序过滤隐藏列，再把固定列按原始顺序整体前移，返回带 `originalIndex` 的结果。排序、过滤、截断与完整单元格读取继续使用 `originalIndex`。
- `fixedLayoutRequired(layout, visible)`：任一可见列有显式宽度或被固定时返回 true。
- `filledWidths(visible, layout, measured)`：为固定布局补全每列宽度：显式宽度 → 调用方测得的宽度 → `DEFAULT_COLUMN_WIDTH = 160`。
- `stickyOffsets(widths, pinned)`：按固定列累计宽度生成 `left` 偏移。
- `setPref / hideColumn / pinColumn / resetColumnWidth / resetLayout`：不可变更新，返回新的 `ColumnLayout`。

替代方案：把布局计算放在 `main.ts` 的 DOM 循环里。否决，因为排序规则（固定列前置、隐藏过滤、粘性偏移）正是最容易出错、最需要单测的部分。

按列名而不是索引保存：刷新 schema、隐藏列或改变列顺序时，列名仍然稳定；同一对象中重名列的支持与现有 `sort`/`filter` 按列名的限制一致。

### D2. 持久化放在宿主，使用单一 `globalState` 映射

新增 `src/host/columnLayoutStore.ts`，依赖一个可注入的最小 Memento 接口（`get/update`），生产环境传入 `context.globalState`：

- **每个对象一个键**：`duckdbViewer.columnLayout.v1.<sha256(objectKey)>`，值为该对象的 `ColumnLayout`；`objectKey = dbPath + "\u0000" + schema + "\u0000" + name + "\u0000" + kind`。用文件绝对路径作为数据库身份，因此同一文件在不同工作区/窗口打开也能恢复。
- 不做跨读缓存：每次 `load` 直接读 Memento，`save` 只写当前对象的键。两个窗口分别保存不同对象时不会互相覆盖；空布局通过 `update(key, undefined)` 删除键。
- 读取时经 `normalizeLayout`；损坏或缺失的值视为空布局。
- 整个扩展共享一个 store 实例，并在停用时等待已发出的写入完成。

替代方案：

- `workspaceState`：作用域更小，但同一数据库换工作区打开就丢失布局；与"按数据库文件记忆"不符。
- webview 的 `getState/setState`：依赖 webview 生命周期，关闭标签页/重启后的恢复不够可控，也不便单测。
- 单键映射（把全部对象放在一个 globalState 键里）：需要先复制整份映射再整体写回，两个窗口会互相覆盖；不再采用。

### D3. 状态与消息：只新增 `setColumnLayout`

- `ViewerState` 增加 `columnLayout: ColumnLayout | null`，表示**当前选中对象**的布局；`emptyState` 中为 `null`。
- 新增 webview → 宿主消息 `setColumnLayout`：`{ schema, name, kind, layout }`。宿主校验三元组与当前选中对象一致，`normalizeLayout` 后持久化并 `mutate({ columnLayout })`；不触发数据库读取。
- 若新布局隐藏了当前排序列，宿主在同一处理中 `mutate({ sort: null, pageIndex: 0, hasPrev: false })`，再通过现有 `enqueue` + `loadPage(firstCursor(), 0)` 重新取第一页。只有这一种布局变更会读取数据库，并沿用现有的 busy/取消/超时语义。
- 不使用 webview 本地缓存：宿主状态始终是布局的唯一事实来源。拖拽过程中的实时宽度只改 DOM，`pointerup` 时一次性发送完整布局；此时没有并发查询，状态回推不会发生在拖拽中途。
- 不给每次调宽加消息节流或单独字段，整份布局体积很小（每列几个标量）。

替代方案：新增 `hideColumn`/`pinColumn` 等细粒度消息。否决，消息契约会膨胀，而宿主最终仍需要完整的布局来持久化。

### D4. 渲染：`<colgroup>` + 固定布局 + 粘性单元格

- 自动模式：没有固定列、也没有显式宽度时，保持现有 `table-layout: auto` 的外观，只是不渲染隐藏列。
- 固定模式：任一可见列被固定或有显式宽度时，`#grid` 加 `table-layout: fixed` 与内联 `width = Σ列宽`，并渲染 `<colgroup><col style="width:Npx">`。
- 首次进入固定模式（第一次调宽或第一次固定）时，先测量所有可见 `th` 的当前宽度，把这些宽度写入布局并随后持久化；这样从自动切到固定时不会发生可见跳变。未被测量过的新列/隐藏后恢复的列使用 `DEFAULT_COLUMN_WIDTH`。
- 隐藏列不渲染 `<col>` 与单元格，但 `rows` 中的原始单元格位置不变：渲染时按 `originalIndex` 取 `row.cells[originalIndex]`，截断判断仍用 `row.truncated.includes(originalIndex)`，双击仍发送原始 `columnIndex`。
- 固定列的 `th`/`td` 都加 `left: <offset>px` 与 `position: sticky`；`thead th` 已经在 `top` 粘性，固定列表头需要同时满足两个方向并提高 `z-index`。固定单元格必须有与行条纹一致的不透明背景，否则滚动内容会透出。
- 固定列用列头中的 `⇤` 标记 + 最右固定列的边框/阴影区分，不使用额外图标资源。
- 排序仍只由列头排序按钮触发。调宽手柄与右键菜单 `preventDefault`/`stopPropagation`，不改变排序。`Shift+F10`/菜单键在列头按钮上打开同一菜单。

### D5. 列头菜单与"全部隐藏"出口

- HTML 增加一个全局的 `#column-menu`（`role="menu"`，默认隐藏）；`renderGrid` 时为每个列头绑定 `contextmenu` 与键盘菜单事件，菜单内容按当前列与当前对象动态生成。
- 菜单项：隐藏此列、固定/取消固定、重置此列宽、显示被隐藏的列（逐列 + 显示所有列）、重置本表列设置。无隐藏列时隐藏该分组。
- 菜单在以下情况关闭：选择菜单项、点击外部、Esc、窗口失焦、网格重新渲染。菜单位置以列头矩形为锚点并 clamp 到视口内。
- 定位锚点与焦点恢复目标分开：定位用列头单元格，Esc 关闭时把焦点还给列头排序按钮（`th` 本身不可聚焦）。
- 当所有列都被隐藏时，网格没有列头，菜单不可达；此时复用 `#empty` 区域展示"所有列已隐藏。"与"显示所有列"按钮。`#empty` 的其他空状态继续使用纯文本。
- 隐藏当前排序列时，webview 不需要额外消息：它只发送新布局，宿主按 D3 清排序并取第一页。菜单项文案提示"隐藏后将清除排序"。

### D6. 交互细节

- 调宽：`pointerdown` 记录起始宽度并 `setPointerCapture`；`pointermove` 计算 `clamp(startWidth + dx)`，只更新当前列 `<col>` 宽度与后续固定列的 `left`；`pointerup/pointercancel` 发送完整布局。
- 固定列多选时按原始列顺序排列，不按固定操作顺序。
- 隐藏优先于固定：布局可以同时含 `hidden: true` 与 `pinned: true`；渲染时隐藏胜出，恢复后仍固定在左侧。
- "重置列宽"在自动模式下删除宽度项；在固定模式下把该列设为 `DEFAULT_COLUMN_WIDTH`，其余列不变。
- "重置本表列设置"清空该对象条目并发送空布局，回到自动布局。

### D7. 测试策略

- `test/columnLayout.test.ts`：`normalizeLayout` 容错与 clamp；隐藏过滤；固定列按原始顺序前置；原始索引稳定；固定偏移累计；隐藏优先于固定；各变更函数不可变且不留空项；重置单个/全部；`__proto__`/`constructor` 等特殊列名使用无原型字典正常往返。
- `test/columnLayoutStore.test.ts`：用内存 Memento 断言按数据库+对象隔离、同名列不串、重启后（新建 store 读取同一 Memento）恢复、两个 store 共享同一 Memento 时互不覆盖、损坏数据被忽略、空布局删除条目、`__proto__` 列名往返。
- `test/session.test.ts`：扩展 `makeSession` 注入内存 store；断言 `setColumnLayout` 只更新状态与存储、不产生 `fetchPage`；隐藏当前排序列时清排序并重新取第一页；`selectObject` 带回已保存布局。
- `test/webviewHtml.test.ts` / `webviewDom.test.ts`：`#column-menu` 存在，且 `main.ts` 查询的 id 都在 HTML 中。
- `test/uiContract.test.ts`：`docs/ui-contract.md` 增加 `setColumnLayout` 与 `ViewerState.columnLayout` 说明。
- 手工/Electron 冒烟：在 fixture 上拖宽、隐藏、固定、全部隐藏后恢复，重开标签页确认恢复；确认操作期间不产生查询（除隐藏排序列外），空闲时外部进程仍能写入。

## Risks / Trade-offs

- **首次调宽/固定会让整表切换到固定布局**：所有列在那一刻冻结为当前像素宽度，不再随内容自动伸缩。→ 切换前先测量并沿用当前宽度，视觉上基本无跳变（低于 60px 最小宽度的窄列会被抬到 60px）；用户可用"重置本表列设置"回到自动布局。
- **固定单元格依赖不透明背景**：行条纹、选中/悬停样式需要为 `td.pinned` 显式着色，否则内容会透出。→ 按奇偶行与主题变量分别设置背景，并在冒烟中检查横向滚动。
- **隐藏当前排序列会重新查询**：这是布局变更中唯一会扩大占锁窗口的路径。→ 复用现有 busy/取消/超时机制；菜单文案提前说明。
- **列名是布局键**：同一对象出现重名列时无法分别记忆设置，与现有按列名排序/过滤的限制一致。→ 在设计上与现有行为对齐，不额外引入索引键。
- **globalState 键会累积**：长期打开大量数据库文件会留下每个对象的小键。→ 每个键只有几十到几百字节，空布局会删除对应键；若将来成为问题，可增加按写入时间淘汰的维护任务，不影响消息契约。
- **切换布局时重绘整个网格**：`.grid-wrap` 的滚动位置会保留，但表头焦点会丢失。→ 菜单/拖拽结束后才发消息，重绘发生在交互完成之后。

## Migration Plan

纯新增 UI 与一个隔离的存储键，无数据迁移、无协议破坏。

1. 先落地 `columnLayout.ts` 与单测。
2. 落地 store 与宿主状态/消息接线，扩展 session 测试。
3. 实现 HTML/CSS 与 webview 交互（菜单、调宽、粘性列、恢复出口）。
4. 更新 `docs/ui-contract.md`、`README.md`，运行 `npm run verify` 与 Electron/手工冒烟。

回滚：移除列头菜单、固定布局与 `setColumnLayout` 消息；`duckdbViewer.columnLayouts.v1` 键留在 globalState 中不会影响旧版本。

## Verification

- `npm run typecheck`、`npm run compile`、`npm run test:unit` 全绿。
- 新增单测覆盖 D1/D2/D7 的排序、容错、隔离与"隐藏排序列"行为。
- 手工冒烟：拖宽、隐藏/恢复、固定/取消固定、全部隐藏、重开标签页；横向滚动时固定列保持可见；操作除隐藏排序列外不触发 `fetchPage`；空闲时外部写入仍成功。
