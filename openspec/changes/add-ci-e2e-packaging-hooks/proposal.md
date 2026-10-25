# Proposal

## Why

当前 CI 只验证到"仓库里的源码能编译、能通过单测和锁集成测试"这一层：Windows 与 Ubuntu 各跑一次 typecheck + 82 个测试，约 40 秒。它从未验证过两件用户真正会遇到的事——扩展能否在真实 VS Code 宿主中激活并渲染，以及打包出来的 `.vsix` 是否完整。`.vscodeignore` 一旦漏掉 `@duckdb/node-bindings-*/duckdb.node`，CI 依然全绿，直到用户安装后才暴露。

同时，本地 commit / push 没有任何自动检查：错误要等 push 之后约一分钟才由 CI 反馈，而 `test:electron` 目前只存在于本机的手工命令中。

## What Changes

- CI 新增 **E2E job**：在真实 VS Code 扩展宿主中打开 fixture、加载 schema 与数据网格、验证"查看器打开时外部进程仍可写入"。Windows 直接运行，Ubuntu 通过 `xvfb-run` 提供虚拟显示；缓存 VS Code 下载目录，避免每次约 100MB 的重复下载。
- CI 新增 **package job**：按平台（win32-x64 / linux-x64）执行 `vsce package`，解压 vsix，用**系统 Node**运行 `scripts/verify-packaged.mjs`，断言打包后的 helper 能独立打开 fixture、返回 schema、静止时打开句柄为 0、dispose 成功；上传 vsix 作为构建产物。
- 本地引入 **husky 钩子**：`pre-commit` 跑类型检查、构建、fixtures 与 78 个单元/协议测试（约 15 秒）；`pre-push` 在此基础上追加 4 个锁集成测试（约 30 秒）。E2E 不进钩子（需要 GUI 且会下载 VS Code）。
- 新增可复用的脚本组合（`test:unit`、`test:unit:integration`、`verify:unit`、`verify`），让 CI 与钩子共享同一套验证入口，且 CI 只构建一次而不是两次。
- README 补充"提交前 / 推送前 / CI 各跑什么"，避免钩子变成黑箱。

非目标（不在本次范围内）：nightly 定时任务、tag 触发的 Release 工作流、Dependabot、macOS runner、VS Code 最低版本（1.90）矩阵、ESLint/Prettier。

## Capabilities

### New Capabilities

- `verification-pipeline`: 定义本地与 CI 的分层验证契约——什么时机验证什么、哪一层负责阻断、以及发布物如何被独立于仓库环境地验证。

### Modified Capabilities

无。既有的 `duckdb-viewer` 与 `lock-safety` 描述的是产品行为，本次不改变它们的要求；验证覆盖度属于新的项目能力。

## Impact

- `.github/workflows/ci.yml`：新增 `e2e` 与 `package` 两个 job，`core` job 改为单次构建 + 复用脚本。
- `package.json`：新增 `husky` devDependency、`prepare` 脚本、`test:unit` / `test:unit:integration` / `verify` 脚本。
- `.husky/pre-commit`、`.husky/pre-push`：新增。
- `README.md`：开发章节补充验证分层说明。
- 不改任何运行时代码、不改扩展入口、不新增运行时依赖；打包产物内容保持不变。
- CI 成本：公开仓库标准 runner 不计费；新增约 2 个 E2E job 与 2 个 package job，单个 PR 预计增加 2–4 分钟墙钟时间。
