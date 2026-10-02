# 手搓 Claude Code（Hand-rolled Claude Code）

[![CI/CD](https://github.com/nanlins/CCo/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/nanlins/CCo/actions/workflows/ci-cd.yml)

> 从零构建的 Agent Harness —— 用 4 个里程碑复刻 Claude Code 的架构骨架。
> 智能来自模型，Agent 产品 = 模型 + Harness。这个仓库是"造载具"的练习。

零业务依赖（仅 `@anthropic-ai/sdk` + `dotenv`），TypeScript，`node:test` 测试，`MOCK=1` 离线可跑。

## 快速开始

```bash
# 1. 安装依赖
npm.cmd install          # 或 npm install（PowerShell 执行策略限制时用 npm.cmd）

# 2. 离线演示（不需要 API key）
MOCK=1 npm.cmd start
#   或在 Windows PowerShell 里：
#   $env:MOCK = '1'; npm.cmd start

# 3. 真实 LLM（支持任意 Anthropic 兼容端点）
#    复制 .env.example 为 .env，填写 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / MODEL_ID
npm.cmd start

# 4. 测试
npm.cmd test             # node --import tsx --test tests/*.test.ts
npm.cmd typecheck        # tsc --noEmit

# 5. 代码风格
npm.cmd lint             # ESLint（0 error 才可提交）
npm.cmd format:check     # Prettier 格式检查（npm run format 自动修复）
```

### 全局命令（任意目录启动）

在任何目录输入 `anvil` 或 `小锤` 即可启动（工作区自动跟随当前目录）：

```bash
# 安装一次（在项目目录执行）
npm link

# 之后在任何目录：
anvil              # 或：小锤
```

> 说明：`npm link` 创建全局符号链接，改项目代码即时生效。

演示：`MOCK=1` 下输入任意问题，会看到 agent 循环跑完"写文件 → 读文件 → 总结"三步（mock 剧本），
验证循环、工具分发、权限、压缩、记忆、transcript 全链路。

## Docker 部署（一键启动完整栈）

> 容器化部署：App + Redis + PostgreSQL(pgvector)，环境隔离、端口错开、一条命令启动。
> 终端版应用运行在宿主机（`npm start` / `anvil`），Docker 只提供基础设施（Redis + PostgreSQL+pgvector）。

### 一键启动基础设施

```bash
# 1. 配置 API key（可选：不配则 MOCK 模式）
#    复制 .env.example 为 .env 填写，或设置环境变量
export ANTHROPIC_API_KEY=sk-xxx
export MODEL_ID=deepseek-v4-flash

# 2. 启动 Redis + PostgreSQL+pgvector
docker-compose up -d

# 3. 终端应用连接（.env）
#    REDIS_URL=redis://localhost:6380
#    PG_CONNECTION_STRING=postgres://postgres:491220@localhost:5434/ai_agent
```

### 端口映射

| 服务       | 容器           | 宿主机端口 | 说明                             |
| ---------- | -------------- | ---------- | -------------------------------- |
| PostgreSQL | anvil-postgres | `:5434`    | pgAdmin 连接用（避开本机 5432）  |
| Redis      | anvil-redis    | `:6380`    | 缓存/限流（避开 WSL Redis 6379） |

> 镜像版本：PostgreSQL 用 `pgvector/pgvector:pg17`（带向量扩展），Redis 用 `redis:7-alpine`。
> 容器间通过内部网络通信（`redis:6379` / `postgres:5432`），不受宿主机端口冲突影响。

### 常用命令

```bash
docker-compose up -d --build   # 构建 + 启动
docker-compose logs -f anvil   # 查看应用日志
docker-compose ps              # 查看状态
docker-compose down            # 停止（保留数据卷）
docker-compose down -v         # 停止 + 删除数据卷
```

### 架构说明（面试可讲）

- **多阶段 Dockerfile**：构建 → 生产依赖 → 精简运行镜像（3 层）
- **服务编排**：`depends_on` + 健康检查保证启动顺序
- **数据持久化**：Docker volumes（redis_data / postgres_data）
- **安全**：非 root 用户运行、健康检查探针

### CI/CD

`.github/workflows/ci-cd.yml`：push/PR 时自动跑 `typecheck` → `lint` → `format:check` → `test` → `build` → `docker build`。

## 4 个里程碑（本仓库全部实现）

| 里程碑            | 内容                                                                    | 对应源码                                                                                                  |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| M1 最小闭环       | agent loop + 工具注册表 + 权限三道闸门 + 沙箱 + REPL                    | `src/core/agent.ts` `registry.ts` `permission.ts` `sandbox.ts` `src/repl.ts`                              |
| M2 扩展骨架       | Hooks（4 事件）+ TodoWrite + Subagent + Skill 两级加载                  | `src/core/hooks.ts` `src/tools/todo.ts` `subagent.ts` `skills.ts`                                         |
| M3 长会话与可靠性 | 四层压缩 + Memory + system prompt 分段组装 + 错误恢复 + 流式            | `src/core/compact.ts` `memory.ts` `prompt.ts` `recovery.ts`                                               |
| M4 协作与生产化   | 任务系统 + 后台任务 + cron + 团队/协议/自治 + worktree + MCP + 可观测性 | `src/tools/tasks.ts` `background.ts` `cron.ts` `teams.ts` `worktree.ts` `mcp.ts` `src/core/transcript.ts` |

## 比教学版更早、更重投入的三件事

1. **安全第一**：bash 命令走 `Sandbox`（deny list 纵深防御 + 超时 + 输出上限 + 可选 `SANDBOX_CMD` 容器包装）；
   **完整命令分类器**（`commandClassifier.ts`）：引号感知分段，`;` `&&` `||` `|` 子 shell 逐段判断，
   禁止"只看第一个 token"放行；重定向目标越出工作区直接 deny；`.env`/密钥文件读取直接 deny；
   **`bg_run` 与 bash 同一条权限管线**（同 deny list / 同分类 / 同超时输出上限，后台不是后门）；
   Windows 下自动识别 PowerShell cmdlet 选择对应 shell（避免 cmd/PS 差异导致反复无效重试）；
   文件工具全部 `safePath` 强约束 + **realpath 防 symlink/junction 逃逸**（read/write/edit/delete/list/glob/grep 全覆盖）；
   **受保护路径**（`protectedPaths.ts`）：agent 不得写 `.claude/settings*.json` / `.mcp/*` / `.env` / 密钥文件，
   不得读 `.env`/密钥（PermissionGate + 文件执行器双重拦截，bypass 模式与 settings allow 规则均不得豁免）；
   **web 工具 SSRF 防护**（拒绝 loopback/私网/link-local/云 metadata/multicast/reserved，DNS 解析校验 + 重定向逐跳校验，可配 `WEB_ALLOWED_HOSTS` 白名单）；
   **MCP 信任门**（首次连接展示命令并请求确认；信任按 command/args/url/transport/headers/oauth 完整配置指纹
   持久化到**用户级目录** `~/.anvil/mcp-trusted.json`——agent 可写的 workspace 内的 trusted.json 一律忽略；
   配置变化需重新确认；未确认绝不启动子进程）；
   权限管线 G0 settings.json 多来源规则（**user < project < local < CLI < session 优先级合并**）
   → G1 拒绝 → G2 规则分类器 + **YoloClassifier（LLM 自动审批，YOLO=1 启用，连续 unsafe 回退人工）** → G3 审批。
   见 `src/core/permission.ts`、`commandClassifier.ts`、`protectedPaths.ts`、`yoloClassifier.ts`、`permissionSettings.ts`、`urlguard.ts`、`src/tools/fs.ts`。
2. **提示词缓存友好**：system 稳定段在前（BASE/WORKDIR/MODE/TOOLS），易变段在后；
   system 与 tools 都挂 `cache_control: ephemeral`；工具 schema 顺序稳定；**子 agent 支持 fork 模式**
   （复用父会话历史前缀命中 API 端 prompt cache）。见 `src/llm/client.ts`、`src/tools/subagent.ts`。
3. **测试与可观测性**：`node:test` + `MockLlm` 剧本测试（无网络）；每个会话 `.transcripts/<id>.jsonl` 全事件回放；
   `.audit/events.jsonl` 权限与 worktree 审计流。见 `tests/`、`src/core/transcript.ts`。

## 生产级机制（对齐真实 CC）

- **Hook 16 事件**：UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / SessionStart / SessionEnd /
  Stop（支持 blockingError 自纠 + stopHookActive 防死循环）/ PreCompact / PostCompact / PermissionRequest /
  PermissionDenied 等；HookResult 支持 updatedInput / blockingError / additionalContext / permissionBehavior。
- **SessionMemoryCompact**：压缩前复用 session memory（≥2000 字符直接做摘要，0 API 调用）。
- **错误恢复**：max_tokens 升级→续写、prompt_too_long reactive compact（**连续压缩上限 3 次**，超过抛
  `PromptTooLongError` 结构化错误，不会无限循环）、429/529 指数退避+**备用模型真正传给下一次 complete**、
  token_budget_continuation + diminishing returns（连续 3 次增量 <500 token 停止续跑）。
- **执行效率护栏**：重复工具调用检测（同一调用连续 >2 次即拦截并要求换策略，防止对失败命令盲目重试）；
  单次 run 的 turn/工具调用/输出 token 预算（80% 预警 + 硬上限，`MAX_TOOL_CALLS_PER_RUN` 等可配）；
  失败命令返回结构化错误（exit code + 输出尾部 + 针对性 Hint + 禁止原样重试），模型一次修正。
- **冷启动热切换**：`/apikey` `/baseurl` `/protocol` 修改配置后立即重建 LLM 实例（不再停留在 Mock）。
- **会话全量恢复**：`/resume` 恢复 messages + todos + readFileState + session id + transcript（v2 快照，兼容旧格式）。
- **预算耗尽 → 强制最终报告**：turn/工具调用/LLM 调用/输出 token 任一预算耗尽即进入"最终报告模式"——
  注入不可忽略的 system-reminder，只允许一次小 token（≤1500）文本回复；模型若仍调用工具直接拦截返回错误
  （最多重试 2 次后强制结束）；报告固定四部分（已完成检查/未完成检查/当前证据/风险项）并随 checkpoint 落盘。
- **子 Agent 成本预算**：每个 subagent 独立 maxTurns/工具调用/LLM 调用/输出 token 上限（`SUBAGENT_MAX_*`）；
  父任务全局聚合预算（数量默认 3、工具调用总量、输出 token 总量，`MAX_SUBAGENTS_PER_TASK`/`SUBAGENT_TOTAL_*`）；
  subagent 超预算返回结构化部分结论（不为空），输出统一压缩到 4000 字符（只留摘要 + file:line 证据）。
- **权限审批体验**：`2>/dev/null`、`2>&1`、`>NUL` 不按危险写入处理；连续同类只读命令支持批量授权
  （审批时答 `a` = 允许本任务中的同类命令，按段首命令名匹配，任务结束自动失效）；
  审批提示含风险原因 + 本任务审批次数 + 批量授权选项；明确只读命令保持自动放行。
- **运行中交互与状态**：busy 状态下输入 `>` 显示进度（轮次/工具/耗时/token），普通文字自动排队并在任务结束后依次处理；
  TTY 下每 3s 刷新状态行；Ctrl+C 中止当前 LLM 流并保存部分状态。
- **配额中断保活**：`Insufficient Balance`/`quota`/429 重试耗尽等配额类错误被捕获后保存 checkpoint，
  输出结构化中断报告（已完成/未完成/证据/风险 + 友好错误转译），REPL 保持存活可 `/resume`/`/export`/重试。
- **.env 分层加载**：真实环境变量 > 工作区 .env（HARNESS_CWD）> 项目 cwd .env；
  修复 anvil 全局命令下 `/model` `/apikey` `/baseurl` 写入工作区 .env 后重启不生效的问题。
- **记忆 Dream**：consolidate 四层门控（时间间隔 / 条目阈值 / 会话 / 文件锁），LLM 去重合并矛盾记忆。
- **任务高水位标**：`.highwatermark` 顺序 ID，删除任务后 ID 不重用。
- **后台看门狗**：45s 无输出增长 + 检测交互式提示 → 自动终止。
- **权限冒泡**：队友审批请求发 `permission_request` 到 Lead，Lead 用 `respond_permission` 回复。
- **Reflexion**：`self_review` 工具让模型对工作自检修正。
- **先规划再执行（Plan-and-Execute）**：大任务（长输入 + 多步骤标记，或 `AUTO_PLAN=1` 强制）进入规划阶段——
  独立的小 token 结构化调用先产出步骤清单（进 Todo），主循环再按顺序逐步执行并更新进度；
  规划失败自动降级为直接执行。`src/core/planner.ts`。
- **Rerank**：RAG 检索可选 LLM 二阶段精排（`search_docs` 粗排+精排架构）。

## 扩展功能（本轮新增）

- **多模型路由**：根据任务复杂度自动选择模型（简单→flash / 复杂→pro），`/model` 命令强制指定
- **成本统计**：UsageTracker 实时统计 token 用量（输入/输出/调用次数），`/usage` 可查看
- **Memory 向量化**：`searchByVector` 用 embedding 相似度检索记忆（0 API 调用，比 LLM 选择更快）
- **Redis 集成**：工具结果缓存（TTL 5分钟）+ 会话状态存储 + 滑动窗口限流
- **Docker 基础设施**：docker-compose 编排 Redis+PostgreSQL(pgvector)；DockerSandbox 容器沙箱已接入 bash 工具（`DOCKER_SANDBOX=1` 时命令在容器内执行，隔离文件系统/网络/进程）
- **MCP WebSocket transport**：第 4 种传输方式（stdio/http/sse/ws）。ws 基于 Node 内置全局 WebSocket 客户端真实实现（握手/帧收发/请求响应/通知），含本地 WS server 回归测试（此前为占位实现，已修复）。
- **多会话管理**：SessionManager 支持 list/load/save/delete，已接入 `/sessions` `/session-delete` `/resume`
- **配置热重载**：ConfigWatcher 监听 .env/settings 变化自动重载权限规则（createHarness 装配时启动）
- **对话导出**：exportConversation 支持 Markdown/JSON，已接入 `/export`

## 扩展功能（第二轮新增）

- **Plugin 市场**：PluginMarket 支持本地 plugin 发现/安装/卸载（skills/ 目录扫描），已接入 `/plugins` `/plugin-install` `/plugin-uninstall`
- **AST 级命令分析**：commandAnalyzer 解析 bash 命令结构（管道/重定向/子shell/链接），识别危险模式，判断命令意图
- **终端主题**：深色青蓝 ANSI 主题 + 像素锤子吉祥物（SVG 矢量 logo 见 `assets/anvil.svg`）；Markdown 流式渲染 + 代码块语法高亮 + 长输出分页
- **多语言 i18n**：中英文切换（`ANVIL_LANG` 启动设置 / `/lang` 运行时切换，REPL 界面文案已接入）

## 架构总览

```
用户输入 → UserPromptSubmit hook → [压缩管线 budget→snip→micro→LLM摘要]
        → system prompt 组装 → LLM（重试/退避/降级/应急压缩）
        → stop_reason == tool_use?
            ├─ 否 → Stop hook → 记忆提取 → 输出
            └─ 是 → 逐工具：权限闸门 → PreToolUse hook → 执行 → PostToolUse hook
                 → tool_result 回填 → 回到 LLM
```

机制很多，循环一个。所有横切逻辑（权限、日志、审计、扩展）都挂在 hooks 和管道上，循环保持纯净。

## 配置（.env）

| 变量                                                               | 说明                                                                             | 默认                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------- |
| `ANTHROPIC_API_KEY`                                                | API key（缺省时自动进入 MOCK 模式）                                              | —                           |
| `ANTHROPIC_BASE_URL`                                               | Anthropic 兼容端点（DeepSeek/GLM/Kimi/DashScope 改这里）                         | `https://api.anthropic.com` |
| `MODEL_ID`                                                         | 模型                                                                             | `claude-sonnet-4-6`         |
| `FLASH_MODEL_ID` / `PRO_MODEL_ID`                                  | 多模型路由：简单任务 flash / 复杂任务 pro                                        | —                           |
| `FALLBACK_MODEL_ID`                                                | 429/529 连续失败时切换                                                           | —                           |
| `PERMISSION_MODE`                                                  | `ask` 询问 / `auto` 仅明确 safe 自动放行 / `deny` 拒绝 / `bypass` 全放行（危险） | `ask`                       |
| `YOLO`                                                             | 1 = 启用 LLM 自动审批（YoloClassifier）                                          | `0`                         |
| `SANDBOX_CMD`                                                      | 命令沙箱包装（如 docker run）                                                    | —                           |
| `DOCKER_SANDBOX`                                                   | 1 = bash 命令送进 Docker 容器执行（隔离文件/网络/进程）                          | `0`                         |
| `EXTRA_READ_ROOTS`                                                 | 额外只读目录（PATH 分隔符），read/glob/grep/list 可越出工作区读取                | —                           |
| `WEB_ALLOWED_HOSTS`                                                | web 抓取公网白名单（逗号分隔），非空时仅放行名单内主机                           | —                           |
| `LLM_PROTOCOL`                                                     | `anthropic`（默认）/ `openai`（OpenAI 兼容 Chat Completions）                    | `anthropic`                 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY`                               | OpenAI 兼容端点（`LLM_PROTOCOL=openai` 时）                                      | —                           |
| `ANVIL_LANG`                                                       | 界面语言 `zh` / `en`（运行时 `/lang` 切换）                                      | `zh`                        |
| `REDIS_URL`                                                        | Redis 连接（工具缓存+限流+会话状态）                                             | —                           |
| `VECTOR_STORE`                                                     | 向量存储：`memory` / `pg`                                                        | `memory`                    |
| `PG_CONNECTION_STRING`                                             | PostgreSQL 连接（pgvector）                                                      | —                           |
| `EMBEDDING_BASE_URL/KEY/MODEL`                                     | 语义 embedding（缺省本地哈希）                                                   | —                           |
| `MAX_TOKENS` / `COMPACT_THRESHOLD_CHARS` / `MAX_TOOL_OUTPUT_CHARS` | 上限参数                                                                         | 8192 / 50000 / 50000        |
| `MAX_REPEAT_TOOL_CALLS`                                            | 同一工具调用连续执行上限（超过即拦截，防盲目重试）                               | `2`                         |
| `MAX_TOOL_CALLS_PER_RUN`                                           | 单次 run 工具调用上限（80% 预警，耗尽进入最终报告模式）                          | `80`                        |
| `MAX_RUN_OUTPUT_TOKENS`                                            | 单次 run 输出 token 预算（80% 预警，耗尽进入最终报告模式）                       | `200000`                    |
| `MAX_LLM_CALLS_PER_RUN`                                            | 单次 run LLM 调用次数上限（耗尽进入最终报告模式）                                | `40`                        |
| `AUTO_PLAN`                                                        | 大任务先规划再执行：`1` 强制 / `0` 关闭 / 缺省启发式（长输入+多步骤标记）        | 启发式                      |
| `PLAN_THRESHOLD_CHARS` / `PLAN_MAX_STEPS`                          | 触发规划的输入长度阈值 / 规划步骤数上限                                          | `160` / `8`                 |
| `MAX_SUBAGENTS_PER_TASK`                                           | 单任务 subagent 数量上限                                                         | `3`                         |
| `SUBAGENT_MAX_TURNS/TOOL_CALLS/LLM_CALLS/OUTPUT_TOKENS`            | 每个 subagent 独立预算                                                           | 12 / 15 / 12 / 100000       |
| `SUBAGENT_TOTAL_TOOL_CALLS` / `SUBAGENT_TOTAL_OUTPUT_TOKENS`       | 父任务全部 subagent 的聚合成本预算                                               | 40 / 400000                 |
| `RETRY_DELAY_MS`                                                   | 重试退避延迟（毫秒，缺省指数退避；测试加速用）                                   | —                           |
| `MOCK`                                                             | 1 = 离线演示                                                                     | `0`                         |

## REPL 命令

`/help` `/clear` `/tools` `/config` `/compact` `/tasks` `/memory` `/team` `/mode [ask|auto|deny|bypass]` `/model [模型ID]` `/apikey [sk-xxx]` `/baseurl [url]` `/protocol [anthropic|openai]` `/resume` `/sessions` `/session-delete` `/export [md|json] [路径]` `/plugins` `/plugin-install` `/plugin-uninstall` `/usage` `/lang [zh|en]` `/exit`

`/apikey` `/baseurl` `/protocol` 修改后会**立即重建 LLM 实例**（冷启动无 key 进入 MOCK 后，配置 key 无需重启即可切换真实模型）；`/config` 显示完整且脱敏的协议/端点/模型/key。

交互增强：行尾 `\` 多行输入、`/` 命令 Tab 补全、长输出分页（`--More--`）、代码块语法高亮、`Ctrl+C` 运行中取消（安全点退出）/空闲双击退出、非交互 EOF 自动退出。

> 上线场景配置：启动后 `/model 模型ID` 切换模型、`/apikey sk-xxx` 设置自己的 API key（已持久化到 .env，重启保留）。

## 权限模式（重要）

| 模式     | 行为                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ask`    | 非明确 safe 的操作一律询问用户（默认）                                                                                               |
| `auto`   | **仅明确 safe 分类自动放行**（只读白名单命令 / 工作区内写入 / classifier=safe）；未知或危险命令仍转人工审批                          |
| `deny`   | 拒绝一切需审批操作（只读工具除外）                                                                                                   |
| `bypass` | **显式全放行**（承接旧版 auto 的放行语义）。⚠ 风险：不再有任何人工审批，等同把 shell 完全交给模型，仅建议在隔离容器/一次性环境中使用 |

> 设计说明：旧版 `auto` 会把未识别的危险 bash 命令自动放行，属于安全缺陷；现已把该语义迁移到显式的 `bypass`，`auto` 回归"只放行明确 safe"。

## 使用者的模型配置（推送到 GitHub 后其他人怎么用）

> 你的 API key 在 `.env` 里，已被 `.gitignore` 排除，**不会**推送到 GitHub。其他人克隆后需要自己配置。

### 方式1：首次启动自动引导（推荐）

其他人克隆并 `npm install` 后直接运行，若未配置 key 会显示引导：

```
未检测到模型配置，当前为离线演示模式（MOCK）。
配置真实模型有两种方式：
  方式1：复制 .env.example 为 .env 并填写
  方式2：启动后输入命令（本会话生效）
        /apikey sk-你的key     设置 API key
        /model 模型ID         切换模型
```

### 方式2：运行时命令（无需编辑文件）

```bash
anvil
/model deepseek-v4-flash     # 切换模型（写入 .env 持久化）
/apikey sk-xxx              # 设置自己的 API key（写入 .env 持久化）
```

### 方式3：手动配置 .env

复制 `.env.example` 为 `.env`，取消注释对应模型的配置：

```env
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   # 或其他兼容端点
MODEL_ID=deepseek-v4-flash
```

### 支持的模型端点

| 模型     | baseUrl                                  |
| -------- | ---------------------------------------- |
| DeepSeek | `https://api.deepseek.com/anthropic`     |
| GLM      | `https://open.bigmodel.cn/api/anthropic` |
| Kimi     | `https://api.moonshot.cn/anthropic`      |
| MiniMax  | `https://api.minimaxi.com/anthropic`     |

## 吉祥物

矢量 logo 见 `assets/anvil.svg`（SVG 矢量路径 + 粗糙喷溅滤镜，愤怒锤头 + 无辜笑脸）。终端内以 ANSI 像素画呈现同一形象。

## MCP 示例

```json
// .mcp/servers.json
{ "echo": { "command": "node", "args": ["examples/mcp-echo-server.mjs"] } }
```

然后对 agent 说 "connect to the echo MCP server"，下一轮起 `mcp__echo__*` 工具可用。

> **信任门**：`.mcp/servers.json` 里的 `command` 连接即执行（等同任意代码执行）。首次连接会展示完整命令并请求确认；
> 确认后按 command/args/url/transport/headers/oauth **完整配置指纹**记录到**用户级** `~/.anvil/mcp-trusted.json`
> （agent 可写的 workspace 内的 `.mcp/trusted.json` 一律被忽略，防自我授信）；配置被篡改会要求重新确认；
> `deny` 模式直接拒绝 `connect_mcp`。
> 支持 4 种 transport：`stdio` / `http` / `sse` / `ws`（在配置里加 `"transport": "ws"` + `"url": "ws://..."`）。

## 目录结构

```
src/
  main.ts         装配 + REPL 入口（createHarness 供测试复用）
  config.ts       Anthropic 兼容端点配置
  llm/            client.ts（SDK 封装+流式+cache_control+结构化输出） mock.ts（剧本）
  core/           agent / registry / hooks / permission / sandbox /
                  transcript / prompt / compact / memory / recovery /
                  security（Prompt Injection 检测）/ usage / readFileState
  tools/          fs / shell / todo / skills / subagent / tasks /
                  background / cron / teams / worktree / mcp / index
tests/            node:test 测试（MockLlm，无网络）
tests/eval/       评估场景 + 运行器（npm run eval）
skills/           示例技能（code-review / agent-builder）
examples/         MCP echo 服务器示例
docs/             架构文档 / prompt-design（Prompt 设计说明与效果对比）
```

## 工程文档

- [架构文档](docs/architecture.md)：设计哲学、模块数据流、权限/压缩管线、多 Agent、MCP、可观测性
- [Prompt 设计说明](docs/prompt-design.md)：Prompt 结构、Few-shot 使用、输出格式控制、失败处理、4 个修改前后效果对比
- [RAG 与 pgvector](docs/rag-pgvector.md)：向量检索架构、PostgreSQL 部署、表设计（HNSW/JSONB/全文检索/事务/锁）

## 评估与安全

- **评估**：`npm run eval` 运行 9 个内置场景（含"先规划再执行"轨迹评估、故障注入自修复），输出任务完成率 / 工具调用准确率 / 耗时 / token 用量报告（真实 LLM 需要 .env；`--mock` 仅演示框架）
- **受控审查验收**：`npm run acceptance:openclaw` 用真实 LLM 对 `tests/fixtures/openclaw-review/`（故意植入缺陷的样本项目）做代码审查，
  校验"预算内收敛 + 预算耗尽强制结构化报告"。密钥只通过环境变量 `OPENAI_API_KEY` 传入（默认端点 OpenCode Zen，`OPENAI_BASE_URL`/`MODEL_ID` 可覆盖），不写 .env、不提交。
- **规划实测**：`npm run acceptance:plan` 给一个小锤一个多步骤大任务，打印完整轨迹并判定"先规划再执行 or 直接上手"。
- **安全**：`src/core/security.ts` 在 UserPromptSubmit 阶段检测 Prompt Injection（指令覆盖 / 角色冒充 / 泄露诱导 / 工具滥用），高危命中改写输入并记录审计；配合权限三道闸门 + Sandbox deny list 纵深防御

## 路线图（教学版 → 本仓库的取舍）

- 教学版用 Python + 字符串权限；本仓库 TypeScript + 沙箱 + 分类器 + 审批（安全更早投入）。
- 教学版 glob/grep 走 shell；本仓库原生 JS 实现（Windows 行为一致）。
- 教学版 mock MCP；本仓库真实 stdio/http/sse/ws JSON-RPC 客户端 + 示例服务器 + 信任门。
- 已知取舍（文档化）：SSRF 防护的 DNS 预检与 fetch 再解析之间存在理论 DNS-rebinding 窗口（生产应叠加出口代理）；
  内置 WebSocket 客户端（浏览器规范）不支持自定义请求头；`bypass` 模式为显式全放行，风险由使用者承担。

## 历史说明

本仓库早期历史中存在机器化提交形态：2026-08-07 00:56/00:57 连续两分钟 9+8 个 commit（逐文件提交规程产物）。
该形态源于当时执行的"逐文件提交"自动化规程，不代表真实开发节奏，也不反映代码来源的全部事实；
自 2026-09-29 起已改为功能分支 + 逻辑分组提交 + squash 合并，并以 CI 门禁（测试/lint/格式/构建）作为合并前提。

## 修改记录

- 2026-09-29：
  - 全仓 prettier --write 统一格式（11 个文件），恢复 CI format:check 门禁绿色
  - package.json：新增 prepare 脚本与 husky devDependency；.husky/pre-commit：提交前执行 format:check（纯 JSON 不便注释，用途在此说明）
  - .github/workflows/ci-cd.yml：docker job 增加 hashFiles('Dockerfile') 守卫
  - README.md：新增 CI badge、历史说明与修改记录小节

- 2026-10-02：补充基础设施镜像版本（pgvector:pg17/5434、redis:7-alpine/6380）
