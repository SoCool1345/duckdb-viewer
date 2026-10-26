# Tasks

## 1. 共享列布局逻辑

- [x] 1.1 新增 `src/shared/columnLayout.ts`：定义 `ColumnLayout` / `ColumnPref`、`normalizeLayout`、`visibleColumns`、`fixedLayoutRequired`、`filledWidths`、`stickyOffsets` 以及隐藏/固定/重置的不可变更新函数，按 design D1 处理列名键、隐藏过滤、固定列原始顺序前置、原始索引保留与宽度 clamp。验证：`npm run typecheck` 通过。
- [x] 1.2 新增 `test/columnLayout.test.ts`，覆盖损坏数据容错与宽度 clamp、隐藏列过滤、固定列按原始顺序前置、`originalIndex` 稳定、粘性偏移累计、隐藏优先于固定、单个/全部重置与空项清理。验证：`npm run test:unit -- test/columnLayout.test.ts` 全部通过。

## 2. 宿主持久化与状态接线

- [x] 2.1 新增 `src/host/columnLayoutStore.ts`：基于可注入 Memento 的单键映射，按"数据库路径 + schema + 对象 + kind"读写，读取时经 `normalizeLayout`，空布局删除条目；在 `src/extension.ts` 创建共享实例并传入编辑器 provider。验证：`npm run typecheck` 通过。
- [x] 2.2 新增 `test/columnLayoutStore.test.ts`，用内存 Memento 覆盖按数据库与对象隔离、同名列不串用、用同一 Memento 新建 store 后恢复、损坏记录被忽略、空布局删除条目。验证：`npm run test:unit -- test/columnLayoutStore.test.ts` 全部通过。
- [x] 2.3 扩展消息与状态：`src/shared/messages.ts` 增加 `setColumnLayout` 消息类型与 `ViewerState.columnLayout` 字段（`emptyState` 为 `null`），`src/webview/handlers.ts` 增加对应处理器。验证：`npm run typecheck` 通过。
- [x] 2.4 更新 `docs/ui-contract.md`，补充 `setColumnLayout` 与 `ViewerState.columnLayout` 的载荷和语义。验证：`npm run test:unit -- test/uiContract.test.ts` 通过。
- [x] 2.5 在 `src/host/session.ts` 接入列布局：选中对象时从 store 载入并写入状态；`setColumnLayout` 校验当前选中对象后规范化、持久化并更新状态且不发起查询；若新布局隐藏了当前排序列，则清除排序并通过现有队列重新取第一页；刷新与切换对象沿用 store 中的布局。验证：`npm run typecheck` 通过。
- [x] 2.6 扩展 `test/session.test.ts` 的 `makeSession` 注入内存 store，新增用例：`setColumnLayout` 只更新状态/存储且不产生 `fetchPage`；隐藏排序列时 `sort` 被清空并重新取第一页；切换对象后带回已保存布局。验证：`npm run test:unit -- test/session.test.ts` 全部通过。

## 3. Webview 列布局交互

- [x] 3.1 调整 `src/host/webviewHtml.ts` 与 `src/webview/styles.css`：加入 `#column-menu` 容器，补充固定列粘性定位与不透明背景、固定标识、最右固定列分隔、调宽手柄、菜单及"所有列已隐藏"空状态样式，全部使用 VS Code 主题变量。验证：`npm run compile` 成功，`npm run test:unit -- test/webviewHtml.test.ts test/webviewDom.test.ts` 通过。
- [x] 3.2 改造 `src/webview/main.ts` 的 `renderGrid`：使用 `visibleColumns` 决定渲染顺序，固定布局时输出 `<colgroup>`、表宽与固定列 `left` 偏移，按 `originalIndex` 取单元格并保持截断判断与 `requestFullCell` 的列索引语义；无列可见时展示"所有列已隐藏"与"显示所有列"按钮。验证：`npm run compile` 通过，无头 Edge 加载 `dist/webview.js` 后隐藏/固定列，行列文本与原始列仍一一对应。
- [x] 3.3 实现拖拽调宽：列头右边界手柄使用 pointer 事件实时更新 `<col>` 宽度与后续固定列偏移，限幅 60–2000px，`pointerup/pointercancel` 时发送完整 `setColumnLayout`；首次进入固定布局前测量并沿用现有列宽。验证：无头 Edge 模拟 pointer 拖拽，60px → 100px 与限幅一致，右键不触发排序，固定布局与 `<col>` 宽度保持。
- [x] 3.4 实现列头菜单：右键、`Shift+F10`/菜单键打开；菜单提供隐藏、固定/取消固定、重置列宽、逐列/全部恢复隐藏列、重置本表列设置；点击外部、Esc、窗口失焦或重绘时关闭；隐藏当前排序列时文案提示会清除排序。验证：无头 Edge 走通隐藏/恢复、固定/取消固定、全部隐藏后恢复、重置与键盘打开场景。
- [x] 3.5 更新 `README.md` 功能列表，加入调整列宽、隐藏/恢复列、固定列到左侧与按对象记忆布局。验证：README 描述与实际交互一致。

## 4. 集成验证

- [x] 4.1 运行 `npm run verify`，确认 typecheck、构建、fixtures、单元/协议测试与锁不变量集成测试全部通过。结果：131 个单元/协议测试与 4 个锁集成测试全部通过。
- [x] 4.2 运行 `npm run test:electron`（必要时用 `VSCODE_EXECUTABLE` 指定本机 VS Code）完成冒烟：打开 fixture 调整布局、重开标签页确认恢复，且查看器空闲时外部进程仍能写入数据库；记录结果。结果：Electron 套件通过，包含布局保存、关闭/重开标签页恢复与外部写入验证。
- [x] 4.3 手工验证跨会话恢复：调整某对象布局后关闭标签页并重启 Extension Development Host，重新打开同一数据库与对象，确认列宽、隐藏与固定状态恢复，其他对象不受影响。
  - 结果：VS Code 重启后，`%APPDATA%\Code\User\globalStorage\state.vscdb` 的扩展状态中仍保留 `main.numbers` 的布局键 `duckdbViewer.columnLayout.v1.960fd858...`，宽度为 `id=86 / big=153 / hue=185 / dec=221 / t=70 / d=83 / ts=142`，确认跨重启持久化生效。
  - 说明（自动化限制）：VS Code 在以 `--extensionTestsPath` 运行时强制 `useInMemoryStorage`，`globalState`/`workspaceState` 不会落盘，因此真实重启由普通 VS Code 窗口手工验证；自动化侧仍由 `columnLayoutStore` 单测与 Electron 套件的关闭/重开标签页覆盖。
