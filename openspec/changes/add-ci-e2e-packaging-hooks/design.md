# Design

## Context

见 `proposal.md` 的动机。当前实现状态与约束：

- `ci.yml` 只有一个 `test` job，矩阵为 `windows-latest` / `ubuntu-latest` + Node 20，步骤是 `npm ci` → `typecheck` → `npm test` → `npm run test:integration`。实测 Windows 42 秒、Ubuntu 32 秒，其中大部分耗时在 `npm ci`。
- `npm test` 与 `npm run test:integration` 各自执行 `compile + fixtures`，也就是 CI 里构建了两次。
- E2E 只存在于 `npm run test:electron`：`scripts/run-electron-test.mjs` 用 `@vscode/test-electron` 启动真实扩展宿主，未设置 `VSCODE_EXECUTABLE` 时下载 stable VS Code；测试脚本依赖 `.tmp/fixtures/fixture.duckdb` 的副本，通过 `duckdbViewer.__testControl` 读取状态，并在查看器打开期间用第二个 DuckDB 实例写入。
- 打包脚本已按目标平台产出 `win32-x64` / `linux-x64` / `darwin-arm64` 的 vsix；`vsce --target` 会裁剪掉其他平台的原生绑定（已验证 win32-x64 产物为 13.2MB，只含 win32-x64 绑定）。`scripts/verify-packaged.mjs` 能对解压后的 helper 做独立验证，但目前只能手工执行。
- 本地没有钩子，没有任何提交前检查；工作区为公开仓库，标准 runner 不计费，首次 CI 已全绿。

## Goals / Non-Goals

**Goals:**

- 每个 PR / 主分支推送都能在 Windows 与 Ubuntu 上获得真实扩展宿主中的行为信号。
- 每个 PR 都能证明目标平台的 vsix 打包后仍可运行，而不是只在仓库目录里可运行。
- 本地 pre-push 与 CI 核心验证使用同一组脚本入口，本地通过能预测 CI 核心通过。
- CI 每个 job 只构建一次；E2E job 借助缓存把稳定态控制在 5 分钟内。

**Non-Goals:**

- 不使用打包后的 vsix 启动 E2E（E2E 仍走 `extensionDevelopmentPath`；打包产物只验证 helper 的运行时行为）。
- 不验证 vsix 的文件清单（如"只包含目标平台绑定"）；这属于后续的体积/内容审计。
- 不引入 macOS runner、VS Code 最低版本矩阵、nightly、tag 发布、Dependabot、ESLint/Prettier。

## Decisions

### 1. 用 husky v9 + `prepare`，而不是原生 `.githooks` + `core.hooksPath`

- **理由**：`npm install` 后自动生效，不需要每个克隆者记得执行 `git config core.hooksPath`。Windows 上钩子由 Git Bash 的 `sh` 执行，`npm run ...` 可正常工作。
- **备选**：`.githooks/` + 文档说明——零依赖，但一定会有人漏配，钩子形同虚设。
- **代价**：多一个 devDependency，`.husky/_` 为生成目录（自带 `.gitignore`）。

### 2. 提交前跑 typecheck + 单元测试；推送前追加锁集成测试

- 实测：typecheck 4.1 秒；单元/协议 8.6 秒；锁集成 10.1 秒；构建与 fixtures 各为秒级。合计 pre-commit 约 15 秒，pre-push 约 30 秒。
- **理由**：单元/协议测试会 spawn `dist/helper.js` 并读取 `.tmp/fixtures`，因此 pre-commit 必须先 `compile` + `fixtures`，不能只跑 vitest。把它们放在提交时，可以让"类型坏了"和"逻辑坏了"在同一时机暴露；锁集成测试留在 push，避免每次提交都为进程级锁测试付出成本。
- **备选**：pre-commit 只跑 typecheck（4 秒）——已被明确否掉；pre-commit 跑全量（约 30 秒）——提交过于昂贵，容易被 `--no-verify` 绕过。
- **明确排除**：锁集成测试与 E2E 不进 pre-commit。E2E 还需要图形环境，未设置 `VSCODE_EXECUTABLE` 时还要下载 VS Code；放进钩子会让离线/无显示器环境无法提交。

### 3. 新增共享脚本入口，保留原有脚本

```
test:unit              vitest run（要求 dist 已构建）
test:unit:integration  vitest run --config vitest.integration.config.mts（要求 dist 已构建）
verify:unit            typecheck + compile + fixtures + test:unit
verify                 verify:unit + test:unit:integration
```

`test` / `test:integration` 保持原语义（先构建再测），供人和旧习惯使用。CI 的 `core` job 改为 `compile` + `fixtures` 各一次，随后调用 `test:unit`、`test:unit:integration`；pre-commit 调用 `verify:unit`，pre-push 调用 `verify`。这样"同一入口"落在共享脚本上，且 CI 不再重复构建。

### 4. E2E 作为独立 job，Windows + Ubuntu（xvfb），默认阻断

- Ubuntu 用 `xvfb-run -a npm run test:electron` 提供虚拟显示；Windows 直接运行。
- 缓存 `.vscode-test`，key 为 `vscode-${{ runner.os }}-stable-${{ hashFiles('package-lock.json') }}`，避免每次下载约 100MB 的 VS Code。
- `timeout-minutes: 25`；`fail-fast: false`。
- **默认阻断**（不使用 `continue-on-error`）：否则"端到端失败不被忽略"的要求无法成立。
- **备选**：先 `continue-on-error: true` 观察稳定性——但这会让红灯变成装饰。若上线后出现持续 flaky，再临时降级，并在 tasks 中留下"连续 N 次全绿后恢复阻断"的后续项。
- 说明：E2E 使用开发路径加载扩展，不覆盖"安装 vsix 后加载"的路径；后者由 package job 覆盖 helper 层面。

### 5. package job 按目标平台在对应 OS 上运行

- 矩阵：`windows-latest → win32-x64`、`ubuntu-latest → linux-x64`。不在 Linux 上验证 Windows 产物，因为原生绑定无法在错误平台上执行。
- 步骤：`npm ci` → `fixtures` → `npm run package:<target>` → 解压 vsix → `node scripts/verify-packaged.mjs <extracted>/extension/dist/helper.js .tmp/fixtures/fixture.duckdb` → 上传 `*.vsix`。
- 解压方式按平台区分：Windows 先复制为 `.zip` 再用 `Expand-Archive`；Linux 用 `unzip`。避免依赖 Git Bash 是否带 `unzip`、GNU tar 不支持 zip 等差异。
- **解压目标必须在仓库工作目录之外**（CI 用 `runner.temp`，本地用系统临时目录）。否则 Node 会从解压目录沿目录树向上解析到仓库自己的 `node_modules`，即使 vsix 漏掉 `@duckdb` 也能"验证通过"——这一点已由负向验证实际发现。
- `verify-packaged.mjs` 使用 `process.execPath`（runner 上的 Node 20）启动 helper，helper 从解压目录的 `node_modules` 解析 `@duckdb/node-api`，因此能真实暴露 `.vscodeignore` 漏文件。脚本本身必须加固：helper 启动失败或请求超时时必须以非 0 退出，而不是无限等待响应。
- 不新增 macOS job：`package:darwin-arm64` 仍保留为手工脚本，未验证前不应把 darwin 产物当作可信发布物（这一点在 proposal 的非目标中）。

### 6. job 名称保持稳定，作为分支保护契约

- `core` job 的名称维持 `${{ matrix.os }} / node ${{ matrix.node }}`；新增 `e2e / <os>`、`package / <target>`。
- 分支保护按这些名称引用检查；改名会让保护静默失效。README 记录名称与对应关系。

### 7. 不改动现有 `core` job 的结构与步骤语义

只把"构建两次"改成"构建一次 + 复用脚本"。`permissions`、全局 `concurrency`、`workflow_dispatch` 等加固项不在本次范围，避免把行为变更和流程加固混在一个 change 里。

## Risks / Trade-offs

- **E2E flaky（下载失败、GUI 启动慢、CI 机器负载）** → 缓存 VS Code；测试内部已用 15–20 秒轮询；`timeout-minutes: 25`；失败时优先重跑一次再改代码。若两周内 flaky 超过可接受频率，临时加 `continue-on-error` 并记录恢复条件。
- **Ubuntu 缺少 `xvfb-run`** → `ubuntu-latest` 镜像通常自带；若缺失，在该 job 增加 `sudo apt-get install -y xvfb`（任务中列为可选回退）。
- **husky 的 `prepare` 在 CI 或生产安装中执行** → husky v9 在无 `.git` 时安全退出；但若未来使用 `npm ci --omit=dev`，`prepare` 会因缺少 husky 而失败，需要在引入时避免该安装方式。
- **钩子拖慢提交/推送** → pre-commit 约 15 秒、pre-push 约 30 秒，且集成测试与 E2E 不在提交时机运行；紧急情况允许 `--no-verify`，README 说明这是例外而非常态。若 pre-commit 因机器较慢明显超出 30 秒，优先考虑把单测并行度调到 CPU 数而不是取消单测。
- **package job 增加约 1–2 分钟** → 与 core 并行执行，不延长关键路径；只覆盖两个目标平台。
- **验证的是 helper 而不是完整扩展** → 扩展入口与 webview 的行为由 E2E 覆盖；两者合起来接近用户路径，但仍不等于"安装 vsix 后启动 VS Code"。这是有意识的边界，记录在 Non-Goals。
- **Windows 解压实现差异** → 固定为"复制成 .zip + Expand-Archive"；Linux 固定 `unzip`，避免隐式依赖。

## Migration Plan

1. 合并后，开发者下一次 `npm install` 会自动安装钩子；无需额外动作。
2. 首次推送后观察 `e2e` 与 `package` 的耗时和稳定性；先不把它们加入分支保护。
3. 连续若干次全绿后，在分支保护中添加 `e2e / windows-latest`、`e2e / ubuntu-latest`、`package / win32-x64`、`package / linux-x64`。
4. 回滚：删除新增的 `.husky/` 与 `package.json` 中的 `prepare`，从 `ci.yml` 移除 `e2e` / `package` job 即可；不涉及运行时数据或发布版本。

## Open Questions

- 是否在合并后立即把 E2E 设为分支保护的必需检查？建议先积累 5 次全绿再设为必需，该决定不影响代码与任务拆分。
