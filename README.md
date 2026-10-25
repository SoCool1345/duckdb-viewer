# DuckDB Viewer

在 VS Code 里直接打开 `.duckdb` / `.ddb` 文件，浏览 schema 与表数据——**不占用数据库锁**。

## 它解决什么问题

DuckDB 的并发模型是"单写入进程"。即使你只打开一个**只读**连接，别的进程（notebook、定时任务、CLI）也无法再以读写方式打开同一个库，只会得到一个 `File is already open in ... (PID n)` 错误。

DuckDB Viewer 因此不做长连接：每次读操作建立只读连接，取完数据立刻关闭。你在编辑器里翻表的时候，后台的写入作业照常运行。

```
[open][query][close]   [open][query][close]   [open][query][close]
 ^ 锁只在毫秒级窗口内存在 ^
```

## 功能

- `.duckdb` / `.ddb` 只读标签页，左 schema 树、右数据网格
- 表/视图列表，列名、类型、可空性、主键
- 分页浏览（rowid 键集分页，视图退化为 offset 并标注"顺序不保证稳定"）
- 点击列头排序、单列过滤（包含/等于/大于/小于）
- 长值截断，双击查看完整内容
- 外部写入检测：数据变化时提示，可手动刷新
- 被其他进程占用时显示占用者 PID/进程名，支持"重试 / 等待释放"
- 状态栏显示是否持有锁；`DuckDB: Release Database Lock` 可立即终止助手进程
- 查询超时（默认 20 秒）与手动取消，两者都会释放句柄

## 不使用它的理由（v1 边界）

- 不能编辑数据、不能执行 SQL
- 不能打开被其他进程以读写方式占用的库（这是 DuckDB 的限制，不是插件的）
- 不支持 Parquet/CSV 等其他数据源

## 安装与打开

1. 安装扩展
2. 在资源管理器里右键 `.duckdb` 文件 → **Open With DuckDB Viewer**
3. 或命令面板运行 `DuckDB: Open Database File`

扩展不会抢占文件的双击默认行为。想让它成为默认：

```json
"workbench.editorAssociations": {
  "*.duckdb": "duckdbViewer.database",
  "*.ddb": "duckdbViewer.database"
}
```

## 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `duckdbViewer.pageSize` | `100` | 每页行数 |
| `duckdbViewer.operationTimeoutMs` | `20000` | 单次操作上限，超时即释放句柄 |
| `duckdbViewer.maxCellBytes` | `4096` | 单元格截断阈值 |

## 开发

要求 Node.js 20+。

```bash
npm install
npm run compile      # 构建 dist/extension.js、dist/helper.js、webview 资源
npm test             # 单元 + 协议测试
npm run test:integration   # 锁不变量集成测试
npm run fixtures     # 重建测试用 DuckDB 库（.tmp/fixtures）
```

端到端冒烟测试（会在真实扩展宿主中打开 fixture 库）：

```bash
# VSCODE_EXECUTABLE 指向本机 Code.exe；不设置则下载稳定版 VS Code
VSCODE_EXECUTABLE="/path/to/Code.exe" npm run test:electron
```

调试：用 VS Code 打开本仓库，按 **F5**，会启动一个加载了本扩展的调试宿主。用 `DuckDB: Open Database File` 打开 `.tmp/fixtures/fixture.duckdb`。

Python 环境（`pyproject.toml`、`.venv`）只用于早期手工验证 DuckDB 锁行为，运行时不需要，发布包里也不包含。

## 锁安全是如何保证的

细节见 `docs/lock-model.md`。三条结构性保证：

1. 助手进程静止时打开句柄数为 0（`status` 可查，测试断言）
2. 代码中不存在以读写方式打开数据库的路径
3. 助手比扩展宿主寿命短：stdin 关闭即退出，3 秒无心跳自杀

## 已知限制

- 数据库由更新版本的 DuckDB 写入时无法读取：插件会明确报错，并**不会**尝试改写文件
- 网络盘/SMB 上的文件锁语义不可靠
- 需要 `spatial` 等扩展的类型在未加载扩展时可能显示为不可读占位
