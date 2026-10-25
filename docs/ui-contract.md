# Webview 消息契约

扩展宿主与 webview 之间只有两个方向的消息：webview 发请求，宿主回状态。没有共享内存、没有直接调用。

## webview → 宿主

消息类型清单与 `src/shared/messages.ts` 中的 `WEBVIEW_MESSAGE_TYPES` 一一对应；`src/webview/handlers.ts` 是唯一入口，测试会断言二者键集合相等。

| type | 载荷 | 说明 |
|---|---|---|
| `ready` | — | webview 脚本就绪，请求宿主推送当前状态 |
| `selectObject` | `schema`, `name`, `kind: 'table' \| 'view'` | 选中表或视图，重置排序/过滤并读取第一页 |
| `sort` | `column` | 切换该列排序（升序 → 降序 → 取消） |
| `filter` | `column`, `op: 'eq' \| 'contains' \| 'gt' \| 'lt'`, `value` | 应用单列过滤，回到第一页 |
| `clearFilter` | — | 清除过滤 |
| `nextPage` | — | 下一页 |
| `prevPage` | — | 上一页 |
| `refresh` | — | 重读 schema 与当前页 |
| `requestFullCell` | `rowIndex`, `columnIndex` | 读取被截断单元格的完整值（需要 rowid） |
| `retryOpen` | — | 打开失败或被占用后重试 |
| `waitForRelease` | — | 进入"等待占用释放"轮询（1 秒一次） |
| `cancelOperation` | — | 中断当前正在执行的请求，句柄随之释放 |
| `cancelWait` | — | 取消等待释放，停止轮询 |

## 宿主 → webview

| type | 载荷 | 说明 |
|---|---|---|
| `state` | `ViewerState` | 全量状态快照，每次状态变化都整体推送 |
| `toast` | `level: 'info' \| 'error'`, `message` | 短时提示 |
| `cellDetail` | `text`, `truncated` | 完整单元格内容 |

`ViewerState` 的字段定义见 `src/shared/messages.ts`。其中：

- `status`：`idle` / `loading` / `locked` / `error` / `ready`
- `busy`：是否有请求正在进行；为真时界面显示"查询中（持有锁）"并提供取消按钮
- `lock`：被其他进程占用时的信息（`pid`、`processName`、`waiting`）
- `banner`：外部写入提示
- `rows[].truncated`：该行中被截断的列下标，双击可请求完整值
- `stableOrder`：为假时界面标注"顺序不保证稳定"

## 状态推送规则

- 每次操作开始时推送 `busy: true` 与 `status: 'loading'`，结束时推送 `busy: false`。
- 状态是快照而不是增量，因此宿主可以安全地丢弃旧消息；webview 不做合并。
- 外部写入通过文件指纹检测：响应携带的 `(mtimeMs, size)` 与上次不同时，`banner` 被置为警告文案，刷新后清除。
