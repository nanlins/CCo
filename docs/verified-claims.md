# 已验证结论（Verified Claims）

> 用途：README / docs 中每个数字与结论的**唯一来源表**。每条含：验证命令、环境、实际结果、commit SHA、日期。
> 规则：找不到来源的数字必须删除或标注"未验证"；本表只记录**真实执行过**的命令与输出。

## 环境

| 项 | 值 |
| -- | -- |
| OS | Windows 11（NT 10.0.26200） |
| Node | v24.15.0 |
| npm | 11.12.1 |
| 日期 | 2026-10-12 |
| 仓库 | `D:\gitcode\识++练\比特-项目\修正\CCo`（基线 commit `108dbd0`，本轮改动为工作区 diff、未提交） |
| 干净副本 | `E:\修正\clean-verify-CCo`（由 `scripts/verify-clean-clone.ps1` 生成并执行） |

## 结论表

| # | 结论 / 数字 | 验证命令 | 实际结果 | commit SHA | 日期 |
| - | ----------- | -------- | -------- | ---------- | ---- |
| 1 | 测试全绿：402 pass / 0 fail | `npm test` | `tests 402 / pass 402 / fail 0`（D: 与 E: 均为此值） | 工作区 diff（基线 108dbd0） | 2026-10-12 |
| 2 | 覆盖率：行 85.53% / 分支 79.53% / 函数 76.69% | `node --import tsx --test --experimental-test-coverage tests/*.test.ts` | `all files 85.53 / 79.53 / 76.69`，402 pass | 工作区 diff | 2026-10-12 |
| 3 | 类型检查通过 | `npm run typecheck` | exit 0（D: 与 E:） | 工作区 diff | 2026-10-12 |
| 4 | Lint 通过 | `npm run lint` | exit 0（0 error） | 工作区 diff | 2026-10-12 |
| 5 | 格式检查通过 | `npm run format:check` | `All matched files use Prettier code style!` | 工作区 diff | 2026-10-12 |
| 6 | 构建通过 | `npm run build` | exit 0，产出 `dist/main.js` | 工作区 diff | 2026-10-12 |
| 7 | 依赖审计 0 high 漏洞 | `npm audit --registry=https://registry.npmjs.org --audit-level=high` | `found 0 vulnerabilities`（修复 brace-expansion 后） | 工作区 diff | 2026-10-12 |
| 8 | 发布包内容正确 | `npm pack` + `tar -tzf nanlins-cco-0.1.0.tgz` | 含 `package/dist/main.js`、`package/bin/anvil.js`、`package/LICENSE`、`package/package.json`；不含 `src/`、`tests/` | 工作区 diff | 2026-10-12 |
| 9 | 隔离安装后 CLI 可用 | 临时目录 `npm install <tgz>` 后 `node node_modules/@nanlins/cco/bin/anvil.js --version`；Windows shim `node_modules\.bin\anvil.cmd --version` | 输出 `cco 0.1.0 (anvil)`（两种入口均 exit 0） | 工作区 diff | 2026-10-12 |
| 10 | compose 配置可解析 | `POSTGRES_PASSWORD=ci-placeholder docker compose config --quiet` | exit 0（无警告；`version` 字段已移除） | 工作区 diff | 2026-10-12 |
| 11 | 干净副本可复现 | `scripts/verify-clean-clone.ps1 -Dest E:\修正\clean-verify-CCo` | `npm ci → typecheck → lint → format:check → test → build → cli --version` 全过，输出 `ALL GREEN` | 工作区 diff | 2026-10-12 |
| 12 | `npm ci` 可从 lockfile 还原 | `npm ci`（lockfile resolved 全指向 registry.npmjs.org） | `added 168 packages`，exit 0 | 工作区 diff | 2026-10-12 |
| 13 | Windows 矩阵命令可用（node --test glob/覆盖率） | Windows 本机执行 CI 同款覆盖率命令 | 402 pass，exit 0 | 工作区 diff | 2026-10-12 |
| 14 | dist 陈旧脚枪已修复 | `npm test`（`tests/anvil-entry.test.ts`：src 新于 dist→告警回退源码；CCO_USE_DIST 强制；旧名兼容） | 全部通过 | 工作区 diff | 2026-10-12 |
| 15 | 旧名清零 | `git grep handrolled-claude-code` / `git grep claudecode-anvil` / `git grep anvil-redis` / `git grep anvil-postgres` | 0 命中；`ANVIL_*`/`HARNESS_CWD` 仅存在于兼容映射与 deprecated 标注处 | 工作区 diff | 2026-10-12 |
| 16 | 密码卫生 | `git status --short`、`git check-ignore .env` | `.env` 不在待提交列表（gitignore 生效）；仓库内无真实密码（P2-3 轮已清） | 工作区 diff | 2026-10-12 |

## 未验证 / 无法本机验证项

| 项 | 原因 | 需在哪验证 |
| -- | ---- | ---------- |
| Docker 镜像构建（`docker build`）与 `docker compose up -d` 健康检查 | 本机 Docker daemon 未运行（`docker version` 连接 npipe 失败） | GitHub Actions `docker` 作业（push 后）；或本机启动 Docker Desktop 后重跑 |
| Linux 全量验收 | 本机为 Windows | GitHub Actions `test` 作业 ubuntu-latest（CI run URL 待推送后补） |
| 真实 LLM 验收（`acceptance:nanoclaw` / `acceptance:openclaw`） | 需要外部密钥且依赖本机项目路径（现改为 `NANOCLAW_PATH` 显式传入，未设置则 SKIP） | 有密钥的环境按脚本头部用法执行 |
| CI 真实 Actions 全绿 | 尚未 push（规则：等用户确认后才 commit/push） | 推送后补 run URL 到本表 |

## 修改记录

- 2026-10-12：新增（交付质量：结论与数字可验证）。
