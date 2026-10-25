# 锁模型

这个插件存在的理由只有一个：让用户在 VS Code 里看 DuckDB 库，而**不挡住正在写这个库的进程**。

## DuckDB 的并发模型（实测）

Windows 10 / DuckDB 1.5.6，用独立进程逐项验证：

| 场景 | 结果 |
|---|---|
| 两个进程各持只读连接 | 允许 |
| 他进程持只读连接，本进程读写打开 | 失败，错误含 PID 与可执行文件名 |
| 他进程持读写连接，本进程只读打开 | 失败 |
| 他进程持读写连接，本进程复制文件 | Windows 上失败（强制性文件锁） |
| 库含未 checkpoint 的 WAL，只读打开 | 成功读到 WAL 中已提交数据，`.wal` 原样保留 |
| 数据库文件带只读属性，只读打开 | 成功，不需要目录写权限 |

结论：**只读连接也会挡住写入**。所以"只读"不等于"无副作用"，必须控制句柄的存活时间。

单次操作成本（1M 行 / 3MB 测试库）：

| 方式 | 耗时 |
|---|---|
| 进程内 `open → 取一页 → close` | ~44ms（open 24ms + page 20ms） |
| 复用连接热查询 | ~14ms |
| 冷启动进程（启动 + import + open） | ~480ms |

44ms 足够便宜，因此不需要为了性能而持有连接。

## 句柄纪律

1. 助手进程启动时不打开任何文件。
2. 一次请求 = `open(READ_ONLY) → 执行 → close`，`finally` 中释放。
3. 同一 `dbPath` 的请求串行，跨文件默认并行。
4. 代码中不存在以读写方式打开数据库的路径。
5. 助手静止时，`status` 请求必须返回 `openHandles: 0`。

## 故障防线

| 故障 | 防线 |
|---|---|
| 扩展宿主崩溃 / 被强杀 | 助手 stdin EOF 立即退出（主防线） |
| 宿主事件循环卡死 | 助手 3 秒心跳超时自杀（兜底） |
| 单个查询跑太久 | 操作超时 + 用户取消，两者都会中断并释放句柄 |
| 请求在队列里就超时 | 执行前检查取消标记，直接跳过，不打开数据库 |
| 中断后引擎仍不返回 | 5 秒后强制终止助手进程（最后手段） |
| 关闭标签页时查询还在跑 | `dispose()` 立即中断活动请求，不等查询结束或超时 |
| 关闭标签页后返回的响应 | 统一请求入口检查销毁标记，后续续作不会再发起新查询 |
| 助手被替换时的旧进程退出 | pending 请求按进程实例归属，旧实例退出不影响新实例 |
| 用户列与内部别名同名 | 内部 rowid 别名自动避让（`__duckdb_viewer_rowid_1` …） |
| 用户想立刻释放 | `DuckDB: Release Database Lock` 直接终止助手进程 |
| 数据库被别的进程占着 | 解析错误里的 PID/进程名，提供重试与等待释放 |

## 断言 ↔ 测试

文档中的每条断言都对应一个可执行的测试：

| 断言 | 测试 |
|---|---|
| 重复请求后不残留句柄 | `test/protocol.test.ts` → "reports zero open handles after repeated requests" |
| 外部进程可在两次读取之间写入 | `test/lock.integration.test.ts` → "lets an external process write between viewer reads" |
| 只读模式拒绝写入且不改文件 | `test/readonly.test.ts` → "rejects writes and leaves the file untouched" |
| 超时后释放句柄 | `test/protocol.test.ts` → "abandons a timed-out query and releases the handle" |
| 排队中已超时的请求不会执行 | `test/protocol.test.ts` → "does not execute a queued request that already timed out" |
| 关闭标签页立即释放句柄 | `test/lock.integration.test.ts` → "releases the handle when a tab is closed mid-query" |
| 关闭标签页后不再发起新查询 | `test/session.test.ts` → "does not start a second request when disposed while the schema is loading" |
| 旧助手退出不影响新助手 | `test/protocol.test.ts` → "does not let a stopping helper reject requests to its replacement" |
| 内部别名不与用户列冲突 | `test/protocol.test.ts` → "does not let the rowid alias collide with a user column" |
| 真实宿主中浏览与外部写入 | `npm run test:electron`（schema、网格、外部写入断言） |
| 取消后释放句柄 | `test/protocol.test.ts` → "cancels an in-flight request on demand and releases the handle" |
| 宿主死亡后助手退出并解锁 | `test/lock.integration.test.ts` → "exits the helper when its parent dies and frees the file" |
| 读取 WAL 但不 checkpoint | `test/lock.integration.test.ts` → "reads committed WAL data without checkpointing or modifying the files" |
| 被占用时能识别占用者 | `test/errors.test.ts` → "classifies the Windows message as LOCKED"、`...POSIX...` |

运行方式：

```bash
npm test              # 单元与协议测试
npm run test:integration
```
