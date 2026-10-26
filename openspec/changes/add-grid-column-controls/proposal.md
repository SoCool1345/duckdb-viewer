# Proposal

## Why

当一个对象列很多、或某些列内容很宽时，数据网格只能横向滚动，关键列很快被挤出视野；无关列又无法收起，每次打开表都要重新忍受同一套布局。查看器已经有稳定的对象与列元数据，因此可以记住每个对象的列布局，让用户按自己的阅读习惯调整一次即可长期使用。

## What Changes

- 支持拖动列头边界调整列宽，宽度作用于该列的表头与所有单元格，并设有合理下限。
- 支持通过列头右键菜单隐藏列；被隐藏的列不再出现在网格中，但可通过菜单或"显示所有列"恢复。
- 支持将列固定到网格左侧；横向滚动时固定列保持可见，固定列的相对顺序沿用原列顺序。
- 列宽、隐藏与固定状态按"数据库文件 + 对象 + 列名"保存，切换对象、刷新、重开标签页或重启 VS Code 后恢复。
- 列设置只影响显示：**不新增数据库读取路径，不改变排序/过滤的查询语义，不扩大占锁窗口**。

非目标：拖拽重排列、固定到右侧、隐藏列时从查询中排除以降低传输、跨对象批量套用布局、布局导入/导出。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `duckdb-viewer`: 在数据网格上新增调整列宽、隐藏/恢复列、固定列到左侧，以及按对象记忆列布局的用户可见行为。

## Impact

- Webview：`src/host/webviewHtml.ts`（列头右键菜单与"所有列已隐藏"空状态容器）、`src/webview/main.ts`（列布局渲染、拖拽调宽、右键菜单、恢复入口）、`src/webview/styles.css`（固定列粘性定位、调宽手柄、菜单样式）。
- 共享层：新增 `src/shared/columnLayout.ts`（列设置类型、默认值、可见列与固定偏移计算、设置变更的纯函数）；`src/shared/messages.ts` 增加列设置消息与状态字段。
- 宿主层：`src/host/session.ts` / `src/host/editorProvider.ts` 读取并持久化列设置；新增一个基于 `ExtensionContext` Memento 的列设置存储（可用内存 Memento 单测）。
- 文档：`docs/ui-contract.md` 补充webview 消息（`test/uiContract.test.ts` 会强制要求）；`README.md` 功能列表补充列宽/隐藏/固定。
- 测试：新增列布局纯函数单测与存储单测；扩展 webview HTML/DOM 契约测试；无新增运行时依赖。
- 不改动 `src/helper/*`、JSON-RPC 协议与数据库访问路径，因此锁安全能力不受影响；隐藏列仍随整行读取，`requestFullCell` 的列索引语义不变。
