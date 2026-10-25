# Proposal

## Why

DuckDB 的 `.duckdb` 文件在 VS Code 里是一团二进制，用户只能靠 SQL 或 shell 去翻表。更麻烦的是 DuckDB 的并发模型：即使只读连接，也会让其他进程的写入失败（`File is already open in ... (PID N)`）。把数据库打开在编辑器里的常规做法——维持一个长连接——会直接堵住用户的 notebook、脚本和定时任务。因此需要一种"能看，但绝不占住库"的查看器。

## What Changes

- 新增 VS Code 扩展，注册 `.duckdb` / `.ddb` 的只读自定义编辑器（`CustomReadonlyEditorProvider`），作为非默认打开方式。
- 编辑器内提供 schema 树（schema → table/view → column 类型与可空性）与数据网格（分页、点击表头排序、列级基础过滤）。
- 所有数据库访问通过独立助手进程完成，且**每次操作建立连接、取完数据立即关闭**，静止时不存在任何打开的文件句柄。
- 打开失败（被其他进程占用）时，展示占用者 PID 与进程名，并提供"重试 / 等待释放"流程。
- 助手进程不会比扩展宿主活得更久：stdin 关闭或心跳丢失即退出，避免 VS Code 崩溃后留下占锁的孤儿进程。
- 状态栏与编辑器标题显示当前是否持有数据库锁（v1 常态为"未占锁"）。

非目标（v1 不做）：写入/编辑数据、SQL 控制台、导出 CSV、DDL 展示、精确行数按钮、附加外部 parquet/csv 数据源、DuckDB 扩展自动安装。

## Capabilities

### New Capabilities

- `duckdb-viewer`: 把 `.duckdb` 文件作为只读编辑器打开，浏览 schema 与表数据，包含分页、排序、过滤与外部变更提示。
- `lock-safety`: 定义扩展与数据库文件的锁关系——句柄生命周期、只读约束、孤儿进程防护、占用冲突的用户可见行为，以及可自动验证的锁不变量。

### Modified Capabilities

无。项目当前没有任何既有 spec。

## Impact

- 新增扩展工程：TypeScript 源码、esbuild 构建、webview 资源、VS Code 扩展清单（`package.json` contributions）。
- 新增 Node 助手入口：依赖 `@duckdb/node-api`（1.5.6 线，与用户环境的 DuckDB 1.5.6 对齐），扩展与助手之间通过 stdio JSON-RPC 通信。
- 新增测试：锁不变量集成测试（外部进程并发写入 + 句柄归零 + 杀宿主后文件立即可写），以及助手协议单元测试。
- 现有 Python 探测环境（`pyproject.toml`、`.venv`）保留，用于锁行为的对照验证，不作为运行时依赖。
- 对用户环境无新增要求：不需要 Python，不需要预装 DuckDB CLI。
