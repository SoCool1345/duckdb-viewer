# Tasks

## 1. 工程骨架

- [x] 1.1 创建 `package.json`、`tsconfig.json`、esbuild 构建脚本（扩展入口 + webview 双目标），并固定 `@duckdb/node-api@1.5.6-r.2`；验证：`npm install && npm run compile` 成功产出 `dist/extension.js` 与 webview 资源
- [x] 1.2 添加扩展激活入口、`deactivate` 钩子与最小命令，注册 `.duckdb`/`.ddb` 的 `customEditors` 贡献点（`priority: "option"`）；验证：F5 启动调试宿主后命令面板可见该命令，且 `.duckdb` 双击仍走系统默认行为
- [x] 1.3 添加 `.vscode/launch.json`、`.vscodeignore`、`.gitignore` 补充项（`node_modules/`、`dist/`），并保留现有 Python 探测环境不受影响；验证：`git status` 中不出现构建产物，仓库内 Python 文件未被改动
- [x] 1.4 编写 `README.md` 的开发环境与构建说明；验证：按 README 从零 clone 到 F5 可启动，步骤无缺漏

## 2. 助手进程与锁不变量

- [x] 2.1 实现助手入口：stdio JSON-RPC 分帧、请求/响应/通知三类消息、错误码枚举；验证：`npm test` 中协议往返测试（含错误码）通过
- [x] 2.2 实现"每次请求 open → execute → close"的访问器，确保 `finally` 中释放，并统计 `openHandles`；验证：连续 10 次请求后 `status` 返回 `openHandles: 0`，测试断言通过
- [x] 2.3 实现只读约束：只使用 `ACCESS_MODE READ_ONLY`，无读写分支；验证：测试中对同一库发起写入语句被拒绝，且文件 mtime/size 不变
- [x] 2.4 实现生命周期防护：stdin EOF 立即退出，加上 3 秒心跳超时自杀；验证：测试进程关闭助手 stdin 后，助手在 1 秒内退出（`process.exit` 可观测）
- [x] 2.5 实现 `openSession` / `dispose` / `status` / `interrupt` 四个管理方法；验证：测试覆盖"打开→诊断→中断→释放"完整序列
- [x] 2.6 编写 `docs/lock-model.md`：说明 DuckDB 并发模型、实测数据与本项目的句柄纪律；验证：文档中的每条断言都能对应到 `npm test` 里的一个测试名

## 3. 元数据与 schema 浏览数据

- [x] 3.1 实现 `listSchema`：一次请求批量查询 `duckdb_tables()`、`duckdb_columns()`、`duckdb_views()`、`duckdb_constraints()`，过滤系统 schema；验证：对含多 schema、表、视图的 fixture 库，返回结构与预期一致
- [x] 3.2 实现类型归一化映射（DECIMAL/HUGEINT/UUID 文本、嵌套类型结构化文本、BLOB 长度+预览、NULL 标记）；验证：针对每类类型的单元测试断言输出格式且无精度丢失
- [x] 3.3 实现空库与无用户表的返回语义；验证：对空 fixture 库调用返回空集合而非错误
- [x] 3.4 添加 fixture 生成脚本（建库、建表、插入各类型样本），供上述测试复用；验证：脚本可重复执行且产出稳定结果

## 4. 数据读取与查询构造

- [x] 4.1 实现 `fetchPage`：列选择、`ORDER BY`、`WHERE` 过滤、分页参数与返回结构；验证：查询构造单元测试覆盖多列排序、取消排序、单列过滤
- [x] 4.2 实现标识符与字面量的安全拼接（标识符双引号转义、过滤值参数化），拒绝把用户输入进入非值位置；验证：注入样例（含引号、分号、注释符）在测试中不改变语句结构
- [x] 4.3 实现分页策略：有 rowid 时键集分页，否则 `LIMIT/OFFSET` 并返回 `stableOrder: false`；验证：两种对象的返回标记正确，键集分页跨页无重复行
- [x] 4.4 实现行数估算：读取 `duckdb_tables().estimated_size`，与精确 `count(*)` 明确区分；验证：返回结构含 `estimated: true`，界面文案测试通过
- [x] 4.5 实现单元格截断与"取完整值"的独立请求；验证：超长文本在页响应中被截断、完整值请求返回全文
- [x] 4.6 实现取消与超时：中断执行并释放句柄，默认超时 20 秒可配；验证：长查询被取消后 `status` 在 2 秒内回到 `openHandles: 0`
- [x] 4.7 实现变更指纹：每次响应附带 `(mtimeMs, size)`；验证：外部修改文件后后续响应指纹变化

## 5. 自定义编辑器与 webview

- [x] 5.1 实现 `CustomReadonlyEditorProvider` 与 `supportsMultipleEditorsPerDocument: false`；验证：同一文件重复打开只聚焦已有标签页
- [x] 5.2 实现 webview 外壳（CSP nonce、主题变量、左 schema 树 / 右数据区布局、空状态）；验证：调试宿主中打开 fixture 库可见树与空网格，无 CSP 报错
- [x] 5.3 接通 schema 树交互：展开 schema、选中表/视图、展示列名/类型/可空性；验证：手动核对 fixture 库中每张表的列信息与实际一致
- [x] 5.4 接通数据网格：列头、首页数据、上一页/下一页、页码与总行数估算；验证：翻页后行内容与 `duckdb` 手动查询结果一致
- [x] 5.5 实现排序与过滤交互（点击列头、过滤输入、清除过滤、重置到第一页）；验证：排序/过滤后的结果与等价 SQL 手动执行结果一致
- [x] 5.6 实现外部变更横幅与刷新；验证：外部写入后界面出现提示，刷新后提示消失且数据更新
- [x] 5.7 实现错误与空状态：版本过新、文件损坏、查询超时、无匹配数据、不可稳定排序；验证：逐个构造场景，界面展示对应说明而非原始堆栈
- [x] 5.8 编写 `docs/ui-contract.md` 记录 webview 与扩展之间的消息契约；验证：消息类型清单与代码中的 handler 一一对应（测试断言）

## 6. 锁冲突、状态与生命周期

- [x] 6.1 解析 DuckDB 的占用错误，提取 PID 与进程名，映射为 `LOCKED`；验证：对真实占用错误文本的解析测试通过（含 Windows 与 POSIX 两种文本样例）
- [x] 6.2 实现"重试 / 等待释放 / 取消等待"：可取消的 1 秒探测循环，成功后自动继续；验证：外部进程释放后查看器在 2 秒内自动打开，取消后不再有定时器
- [x] 6.3 实现状态栏与编辑器标题的锁指示，以及"释放数据库锁"命令；验证：空闲时显示未占锁，取消长查询后状态立即回到未占锁
- [x] 6.4 实现"锁诊断"命令，展示 `openHandles` 与文件列表；验证：空闲状态下输出句柄数为 0
- [x] 6.5 实现扩展停用/关闭路径：发 `dispose` → 终止助手 → 等待退出（带超时）；验证：关闭 VS Code 后任务管理器中无残留助手进程

## 7. 集成验证与发布

- [x] 7.1 编写锁不变量集成测试：助手执行 10 次读取期间，以独立 node 进程读写打开同一库并写入成功；验证：`npm run test:integration` 通过
- [x] 7.2 编写孤儿进程测试：强制杀死扩展宿主侧进程，断言助手在 5 秒内退出且文件随即变为可写；验证：集成测试断言通过
- [x] 7.3 编写只读安全性测试：浏览含 WAL 的库后，`.duckdb` 与 `.wal` 的 mtime/size 不变，且 WAL 中已提交数据可见；验证：集成测试断言通过
- [x] 7.5 添加 `vsce` 打包配置与 `CHANGELOG.md`，产出一个可在干净环境安装的 `.vsix`；验证：在无 Node、无 Python 的机器上安装该 vsix 后能打开并浏览 fixture 库
