# 交付自审清单（Review Checklist）

> 用途：提交/发布前按本清单自审，逐项给出证据（命令 + 输出），未通过项不得标记完成。
> 适用于 CCo 仓库的每次交付；与 CI 门禁、`docs/verified-claims.md` 配套使用。

## A. 可复现性

- [ ] `git status --short --branch` 无意外改动（工作区与 HEAD 关系清楚）
- [ ] 干净副本全链路绿：`scripts/verify-clean-clone.ps1`（Windows）/ `.sh`（Linux）→ `ALL GREEN`
- [ ] `npm ci`（非 `npm install`）可从 `package-lock.json` 完整还原
- [ ] lockfile 的 `resolved` 全部指向公共注册表（`registry.npmjs.org`），无本机/镜像私有地址

## B. 质量门禁

- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm run format:check` 通过
- [ ] `npm test` 全绿（记录测试数，写入 `verified-claims.md`）
- [ ] `npm run build` 通过；`node dist/main.js --version` 输出正常
- [ ] `npm audit --audit-level=high` 0 漏洞（或已改为 advisory 并在 README 说明）

## C. 打包与容器

- [ ] `npm pack` 产物含 `dist/main.js` / `bin/anvil.js` / `LICENSE` / `package.json`，且不含 `src/`、`tests/`
- [ ] 隔离安装后 `anvil --version` / `anvil --help` 退出码 0、输出符合预期
- [ ] `docker compose config` 通过（哨兵密码 `POSTGRES_PASSWORD=ci-placeholder`）
- [ ] `docker build` 产出镜像（本机无 Docker 时标注"未验证 + 由 CI 验证"）

## D. 命名与文档一致性

- [ ] 全仓库 `git grep` 旧包名/旧镜像名（精确串与实测结果见 `verified-claims.md` #15）只剩历史/审计说明
- [ ] 包名/镜像/容器/网络/环境变量前缀与新规范一致（`@nanlins/cco`、`cco`、`cco-*`、`CCO_`）
- [ ] README 的每个数字与结论都能在 `docs/verified-claims.md` 找到来源
- [ ] 失败路径已写入 `docs/failure-modes.md` 且有测试

## E. 安全与卫生

- [ ] `git status` 不含 `.env` / 密钥 / 日志 / 测试产物 / 嵌套 `.git`
- [ ] `.gitignore` 覆盖运行期状态与探针残留（`.workflow/`、`*.log`、`probe.txt` 等）
- [ ] `git diff --cached` 中无真实密钥（逐文件过一遍新增行）
- [ ] 外部 hook / MCP / 设置文件仍走信任门

## F. 交付物

- [ ] 修改清单（文件 → 模块 → 目的）
- [ ] 命名映射表（旧名 → 新名 → 剩余位置）
- [ ] CI 矩阵表（job → 命令 → 本机结果 → Actions run URL → required）
- [ ] 数字核对表（结论 → 命令 → 结果 → commit SHA → 日期）
- [ ] 待提交清单与 Conventional Commits 草稿（**等用户确认后才 commit/push**）

## 修改记录

- 2026-10-12：新增（交付质量：自审清单）。
