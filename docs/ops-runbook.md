# 运维手册（Ops Runbook）

> 用途：陌生开发者/运维从零把 CCo 跑起来的完整操作手册：前置条件、安装、启动/停止、健康检查、
> 日志与数据位置、端口、常见故障、回滚。所有命令在 Windows PowerShell 与 Linux bash 均标注。

## 1. 前置条件

| 项目            | 要求                                  | 检查命令                                    |
| --------------- | ------------------------------------- | ------------------------------------------- |
| Node.js         | ≥ 20（CI 用 22；本机验证用 v24.15.0） | `node -v`                                   |
| npm             | 随 Node                               | `npm -v`                                    |
| Git             | 任意近版                              | `git --version`                             |
| Docker（可选）  | 基础设施（Redis/PG）与镜像构建需要    | `docker version` / `docker compose version` |
| API key（可选） | 不配则 MOCK 离线模式                  | `echo $env:ANTHROPIC_API_KEY`               |

## 2. 安装

```powershell
git clone https://github.com/nanlins/CCo.git
cd CCo
npm ci          # 按 package-lock.json 干净安装（CI 同款）
```

> `npm ci` 会自动执行 `prepare`（husky + `npm run build`），因此安装后 `dist/` 已就绪。

## 3. 启动 / 停止

```powershell
# 离线演示（无需 key）
$env:MOCK='1'; npm.cmd start

# 真实模型：复制 .env.example 为 .env 填 key，或运行时 /apikey + /model
npm.cmd start

# 全局命令（任意目录，工作区=当前目录）
npm link
anvil                 # 或 小锤
anvil --version       # 版本自检
anvil --help          # 用法

# 停止：REPL 内 /exit；或 Ctrl+C 两次；管道/非交互 EOF 自动退出（exit 0）
```

## 4. 健康检查

| 对象           | 检查命令                                                                | 期望                           |
| -------------- | ----------------------------------------------------------------------- | ------------------------------ |
| CLI/构建       | `node dist/main.js --version`                                           | `cco <semver> (anvil)`，exit 0 |
| 类型/风格/测试 | `npm run typecheck && npm run lint && npm run format:check && npm test` | 全绿                           |
| 真实 LLM       | REPL 内 `/verify`                                                       | `连接成功 ✅ model=…`          |
| Redis          | `docker exec cco-redis redis-cli ping`                                  | `PONG`                         |
| PostgreSQL     | `docker exec cco-postgres pg_isready -U postgres`                       | `accepting connections`        |
| compose 配置   | `$env:POSTGRES_PASSWORD='x'; docker compose config --quiet`             | exit 0（无输出）               |

## 5. 日志与数据位置

| 路径                             | 内容                                   | 说明                     |
| -------------------------------- | -------------------------------------- | ------------------------ |
| `.transcripts/<id>.jsonl`        | 会话全事件（结构化）                   | 出问题首先看这里         |
| `.transcripts/<id>.session.json` | checkpoint 快照（messages/todos/报告） | `/resume`、`/retry` 依据 |
| `.audit/events.jsonl`            | 权限/worktree 审计                     | 安全审查依据             |
| `.memory/`                       | 记忆条目                               | 可直接查看 Markdown      |
| `.workflow/journal.json`         | 工作流运行记录                         | 工作流断点续跑           |
| stderr                           | 降级警告（如持久化失败）               | 只告警一次               |
| Docker: `docker compose logs`    | cco-redis / cco-postgres 日志          | 基础设施侧               |

## 6. 端口

| 服务                 | 端口       | 覆盖方式                                                   |
| -------------------- | ---------- | ---------------------------------------------------------- |
| cco-redis（宿主）    | 6380       | 改 `docker-compose.yml` ports 左值 + `.env` 的 `REDIS_URL` |
| cco-postgres（宿主） | 15434      | 改 compose ports 左值 + `.env` 的 `PG_CONNECTION_STRING`   |
| REPL                 | 无监听端口 | 终端进程                                                   |

## 7. 常见故障

| 症状                                       | 原因                     | 处置                                                           |
| ------------------------------------------ | ------------------------ | -------------------------------------------------------------- |
| 首屏 Mock/引导                             | 未配置 key               | `/apikey`、`/model`，或 `.env` 配置                            |
| `[anvil] dist 落后于 src`                  | 改了 src 未 build        | `npm run build`，或忽略（自动回退源码模式）                    |
| 检索/索引 `检索失败: connect ECONNREFUSED` | PG 未启动或端口不符      | `docker compose up -d`；确认 `PG_CONNECTION_STRING` 端口=15434 |
| 工具缓存似乎不生效                         | Redis 不可用（静默降级） | 启动 `cco-redis`，或接受无缓存模式                             |
| `余额不足/欠费` 中断                       | key 欠费                 | 充值后 `/retry`（复用 checkpoint，不重放全量历史）             |
| 审批卡停留                                 | 等待用户输入             | 输 `y/a/t/n`；Ctrl+C 取消=拒绝                                 |
| compose 报 `POSTGRES_PASSWORD` 未设置      | .env 缺密码              | 在 `.env` 设 `POSTGRES_PASSWORD`（参考 `.env.example`）        |

## 8. 回滚

```powershell
git log --oneline -10          # 找到上一个良好 commit
git checkout <good-sha> -- .   # 仅回滚文件（随后自行 build）
# 或整体切换：
git switch -d <good-sha>; npm ci; npm run build
```

镜像回滚：`docker build -t cco:rollback <good-sha 检出的源码>`；数据卷（`redis_data`/`postgres_data`）不受镜像切换影响；
需要清空时 `docker compose down -v`（⚠ 删除数据）。

## 修改记录

- 2026-10-12：新增（交付质量：运维手册）。
