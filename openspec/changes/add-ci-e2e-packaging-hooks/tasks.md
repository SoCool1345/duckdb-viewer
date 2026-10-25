# Tasks

## 1. 共享验证脚本

- [x] 1.1 在 `package.json` 中新增 `test:unit`（`vitest run`）、`test:unit:integration`（`vitest run --config vitest.integration.config.mts`）、`verify:unit`（`typecheck + compile + fixtures + test:unit`）、`verify`（`verify:unit + test:unit:integration`）四个脚本；验证方式：先 `npm run compile && npm run fixtures`，再分别运行 `npm run test:unit` 与 `npm run test:unit:integration`，两者均通过（78 + 4 个测试）
- [x] 1.2 确认原有 `npm test` 与 `npm run test:integration` 行为不变；验证方式：两条命令各自完整跑通
- [x] 1.3 计时两个共享入口；验证方式：`npm run verify:unit` 在 20 秒内成功，`npm run verify` 在 40 秒内成功（实测基线约 15 / 30 秒）

## 2. 本地钩子

- [x] 2.1 添加 `husky` devDependency 与 `prepare: "husky"`，安装后确认钩子路径生效；验证方式：`npm install` 后 `git config core.hooksPath` 输出 `.husky/_`
- [x] 2.2 新建 `.husky/pre-commit` 执行 `npm run verify:unit`；验证方式：先引入一个类型错误确认 `git commit` 被拒绝，再还原并在任一单测中制造失败，确认 `git commit` 同样被拒绝且输出指出失败测试，最后确认正常状态下提交通过且耗时在 20 秒内
- [x] 2.3 新建 `.husky/pre-push` 执行 `npm run verify`；验证方式：直接执行 `sh .husky/pre-push` 返回 0，并确认 `.husky/_/pre-push` 存在
- [x] 2.4 确认生成的 `.husky/_` 不进入版本库、钩子在 Windows Git Bash 下可运行；验证方式：`git status` 干净，`git ls-files .husky` 只列出 `pre-commit` 与 `pre-push`
- [x] 2.5 在 `README.md` 的"开发"章节补充"提交前 / 推送前各跑什么"（含提交前会跑单测）与 `--no-verify` 的使用边界；验证方式：按文档中的命令逐条执行，结果与描述一致

## 3. CI 核心去重

- [x] 3.1 修改 `core` job：`npm ci` → `typecheck` → `compile` → `fixtures` → `test:unit` → `test:unit:integration`，去掉隐式重复构建；验证方式：本地按同一顺序执行全绿，且 job 名称仍为 `<os> / node 20`
- [x] 3.2 推送后确认 `core` 在两平台通过且总耗时不超过修改前（Windows 42 秒 / Ubuntu 32 秒）；验证方式：对比 Actions 中两次 run 的 job 时长

## 4. E2E job

- [x] 4.1 在 `ci.yml` 新增 `e2e` job：矩阵 `windows-latest` 与 `ubuntu-latest`，Ubuntu 用 `xvfb-run -a npm run test:electron` 包装，缓存 `.vscode-test`（key 含 `runner.os` 与 `package-lock.json` 哈希），`timeout-minutes: 25`，`fail-fast: false`，不使用 `continue-on-error`；验证方式：推送后两个 `e2e` job 均为成功，日志中出现 `[electron-test] schema, grid and external write verified`
- [x] 4.2 确认 Ubuntu job 确实通过虚拟显示启动、Windows job 未依赖 xvfb；验证方式：检查两个 job 的命令行与日志中 VS Code 启动无 display 错误
- [x] 4.3 确认缓存生效；验证方式：同分支连续触发两次，第二次 run 的缓存步骤为命中且 E2E job 耗时明显下降
- [x] 4.4 在 `README.md` 的 CI 说明中记录 `e2e / windows-latest`、`e2e / ubuntu-latest` 两个检查名称；验证方式：名称与 Actions 中 job 显示名逐字一致

## 5. 打包验证 job

- [x] 5.1 在 `ci.yml` 新增 `package` job：矩阵 `windows-latest → win32-x64`、`ubuntu-latest → linux-x64`，步骤为 `npm ci` → `fixtures` → `npm run package:<target>`；验证方式：两个 job 均产出 `duckdb-viewer-0.1.0-<target>.vsix`（本地 Windows 目标已验证）
- [x] 5.2 加固 `scripts/verify-packaged.mjs`：helper 提前退出、启动失败或单次请求超时时必须以非 0 退出并输出原因，不得无限等待；验证方式：把 vsix 解压到系统临时目录（仓库之外）并删除 `@duckdb`，脚本在 10 秒内非 0 退出
- [x] 5.3 在 `ci.yml` 中把 vsix 解压到 runner 临时目录（Windows `$env:RUNNER_TEMP\vsix`，Linux `$RUNNER_TEMP/vsix`），再运行 `node scripts/verify-packaged.mjs`；验证方式：两个 job 输出 `openHandles at rest: 0` 与 `disposed: true`，本地按同一路径形式执行通过
- [x] 5.4 上传 vsix 为构建产物；验证方式：从 run 页面下载 artifact，确认其中包含 `extension/dist/helper.js` 与对应平台的 `@duckdb/node-bindings-*`
- [x] 5.5 在 `README.md` 的 CI 说明中记录 `package / win32-x64`、`package / linux-x64` 两个检查名称；验证方式：名称与 Actions 中 job 显示名逐字一致

## 6. 集成验收与启用

- [x] 6.1 在临时目录做一次干净克隆，执行 `npm install`；验证方式：`git config core.hooksPath` 自动指向 `.husky/_`，无需额外命令
- [x] 6.2 推送分支并开一个 PR，确认 `core`、`e2e`、`package` 全部运行且为绿；验证方式：完整 run 的墙钟时间不超过 8 分钟，且 `npm ci` 未因 `prepare` 失败
- [ ] 6.3 连续 5 次全绿后，在分支保护中加入 `e2e` 与 `package` 的检查（若出现持续 flaky 则先记录原因再决定是否临时降级）；验证方式：GitHub 分支保护页面中的检查名称与最近一次 run 的 job 名称逐字对应
