# 失败模式（Failure Modes）

> 用途：逐一说明关键失败路径的**用户可见行为、日志字段、数据影响、恢复方式、测试覆盖**。
> 约定：所有事件写入 `.transcripts/<sessionId>.jsonl`（结构化 JSONL）；降级路径"不阻断主循环"是承重不变量。
> 覆盖状态：✅ 有测试 · ⚠️ 部分覆盖 · ❌ 未覆盖（在"未验证"小节列明）。

## 总表

| #   | 场景                               | 触发方式                                  | 用户可见行为                                                         | 日志字段                    | 数据影响                          | 恢复方式                                                 | 测试                                                                                      |
| --- | ---------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- | --------------------------- | --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | LLM 余额不足（402/欠费）           | 真实 API 返回 Insufficient Balance        | 结构化中断报告（已完成/未完成/证据/风险）+ 友好错误；REPL 存活       | `quota_error`               | 无：checkpoint 已保存             | `/retry`（复用 checkpoint）或充值后 `/resume`            | ✅ `tests/quota-checkpoint.test.ts`                                                       |
| 2   | LLM 限流 429/529（重试耗尽）       | 连续 429                                  | 中断报告 + `rate_limited` 状态；或已切 fallback 模型继续             | `rate_limited`、`llm_error` | 无                                | 配置 `FALLBACK_MODEL_ID`；稍后 `/retry`                  | ✅ `tests/recovery-fallback.test.ts`                                                      |
| 3   | prompt_too_long（压缩仍超限）      | 长会话触发应急压缩 >3 次                  | 结构化 `PromptTooLongError` 提示（不会无限循环）                     | `compact`、`llm_error`      | 无：历史仍在 transcript           | `/compact` 手动压缩或新开会话                            | ✅ `tests/recovery-fallback.test.ts`                                                      |
| 4   | Redis 断连/不可用                  | 未启动 Redis 或中途断开                   | 无报错（静默降级）：缓存/限流/会话元数据变 no-op                     | 无（设计如此）              | 无：缓存本来就是可丢层            | 启动 Redis（`docker compose up -d`）后自动恢复           | ✅ `tests/redis.test.ts`                                                                  |
| 5   | PostgreSQL/pgvector 不可用         | `VECTOR_STORE=pg` 且 PG 未启动/连接串错误 | 首次检索/索引的工具结果返回 `检索失败: <原因>`；agent 继续（不崩溃） | `tool_use`（`error` 字段）  | 无：工作区文件不受影响            | 修复连接串/启动 `cco-postgres`；或 `VECTOR_STORE=memory` | ✅ `tests/pg-failure.test.ts`                                                             |
| 6   | 持久化写失败（磁盘满/只读）        | 工作区不可写                              | stderr 一次性警告 `[警告] …写入失败…已降级为内存态`；agent 继续      | 无（stderr 告警）           | 会话快照/审计仅存内存，退出后丢失 | 修复工作区权限/磁盘后重启                                | ✅ `tests/persistence-degradation.test.ts`                                                |
| 7   | Hook 执行失败（超时/非零/坏 JSON） | 外部 hooks.json 命令失败                  | 无感知（hook 结果视为空）；项目级未信任时警告并跳过                  | logger `warn`（启动阶段）   | 无                                | 修复 hook 命令；或重新信任                               | ✅ `tests/hook-loader-trust.test.ts`                                                      |
| 8   | MCP 连接失败                       | server 未信任/配置坏/进程起不来           | 工具返回 `Error: MCP server … connection refused/…`，agent 继续      | `tool_use`（`error` 字段）  | 无                                | 修 `.mcp/servers.json` 后重连（信任指纹变更需重新确认）  | ⚠️ `tests/mcp-trust.test.ts`、`tests/mcp-transport.test.ts`、`tests/ws-transport.test.ts` |
| 9   | 启动无配置                         | 无 API key 且非 MOCK                      | 首屏引导（配置方式 1/2/3），进入离线演示                             | 无                          | 无                                | `/apikey`、`/model` 或编辑 `.env`                        | ✅ `tests/cold-start.test.ts`、`tests/first-run-wizard.test.ts`                           |
| 10  | 非交互 EOF / Ctrl+C                | 管道输入结束 / 双击 Ctrl+C                | 进程干净退出（exit 0）；运行中 Ctrl+C 安全点取消                     | `llm_cancelled`             | 无：checkpoint 已存               | 重新启动 `/resume`                                       | ✅ `tests/repl-robustness.test.ts`、`tests/agent-cancel.test.ts`、CI pack smoke EOF 断言  |

## 稳定日志字段（transcript 事件）

主循环写入的结构化事件（节选）：`user_prompt`、`llm_call`、`llm_error`、`llm_cancelled`、`rate_limited`、`quota_error`、
`tool_use`（含 `error`）、`compact`、`plan`/`plan_empty`/`plan_failed`、`repeat_guard`、`path_repeat_guard`、
`tool_injection_suspect`、`permission`、`task_stats`、`final_report_mode`。
每个事件都带 `ts` 与事件专属字段，可被脚本稳定解析（`jq`）。

## 未验证 / 无法验证项

- **Docker 运行时失败路径**（镜像构建失败、容器起不来、健康检查不通过）：本机 Docker daemon 未运行，
  未在本地验证；由 GitHub Actions `docker` / `compose` 作业验证（见 `docs/verified-claims.md`）。
- **真实 PG 断连中途恢复**（连接池重连时序）：未构造真实时序测试，仅验证了"不可用时降级不崩溃"。

## 修改记录

- 2026-10-12：新增（交付质量：失败路径一等公民，逐条给行为/字段/数据/恢复/测试）。
