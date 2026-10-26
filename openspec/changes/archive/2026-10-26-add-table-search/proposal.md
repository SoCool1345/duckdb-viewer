# Proposal

## Why

数据库稍大一些后，左侧 schema 树里滚动查找一个表或列就很费劲。现有查看器已经一次性把全部表、视图和列读入界面状态，因此搜索可以完全在本地内存中完成，不需要新增数据库访问，也不会扩大占锁窗口。

## What Changes

- 在查看器左侧栏顶部新增搜索框，输入即匹配**表名、视图名、列名**（不区分大小写，空格分词后要求全部命中）。
- 搜索结果以扁平列表呈现：对象结果可直接打开；列结果会打开其所属表，并展开、定位、突出显示该列。
- 支持方向键在结果间移动、Enter 打开、Esc 清空；无匹配时显示明确的空状态。
- 搜索完全在前端内存中完成：**不新增助手 RPC，不读取数据库，不影响只读与锁语义**。

非目标：搜索数据值或单元格内容、跨数据库搜索、模糊/拼音匹配、收藏表或列。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `duckdb-viewer`: 在"浏览 schema 结构"之外新增一项用户可见行为——按名称搜索表/视图/列并跳转到结果。

## Impact

- Webview：`src/host/webviewHtml.ts`（搜索框与结果容器）、`src/webview/main.ts`（结果渲染、键盘交互、跳转与突出显示）、`src/webview/styles.css`。
- 共享层：新增 `src/shared/search.ts`（纯匹配/排序逻辑，便于单测）。
- 宿主层：无改动。搜索只在 webview 内基于已推送的 `ViewerState.schemas` 计算，不新增消息，也不新增持久化。
- 文档：更新 `README.md` 的功能列表。
- 测试：新增搜索匹配单测，并扩展 webview DOM 测试；无新增运行时依赖。
- 不改动 `src/helper/*`、JSON-RPC 协议与数据库访问路径，因此锁安全能力不受影响。
