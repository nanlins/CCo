# 架构文档

## 设计哲学

**Agency = Model + Harness**。模型负责判断与行动选择；harness 负责把环境、工具、权限、
记忆、团队和外部能力组织好。本仓库的所有代码都是 harness —— 不给模型加智能，只给它
双手、双眼和工作空间。

三条不可动摇的原则：

1. **循环纯净**：`while stop_reason == "tool_use"` 是唯一的主干。任何新能力都以
   hook / 管道 / 工具注册的方式接入，绝不修改循环本体。
2. **文件系统即数据库**：任务 `.tasks/*.json`、团队收件箱 `.team/agents/*/inbox.jsonl`
   （append-only + drain-on-read）、记忆 `.memory/*.md`、cron 作业 `.cron/jobs.json`。
   简单、可调试、无外部依赖。
3. **上下文预算化**：压缩管线按"便宜的先跑，贵的后跑"排序；大输出落盘而非截断。

## 模块与数据流

```
┌─────────────────────────────────────────────────────────────┐
│ REPL (src/repl.ts)                                           │
│   │ ask（审批复用同一 readline）                              │
│   ▼                                                          │
│ Agent.run(input) (src/core/agent.ts)                         │
│   UserPromptSubmit hook                                      │
│   → inject()（后台任务结果 / cron 触发）                       │
│   → compactMessages（L3 budget → L1 snip → L2 micro）         │
│   → assembleSystemPrompt（稳定段在前 + cache 友好）            │
│   → llm.complete（callWithRetry：退避/降级/应急压缩）           │
│   → stopReason == 'max_tokens'？升级 token / 续写（≤3 次）     │
│   → 有 tool_use？逐工具：                                    │
│       PermissionGate.check（G1 deny → G2 规则 → G3 审批）      │
│       → PreToolUse hook → registry.execute → PostToolUse hook │
│       → tool_result 回填                                      │
│   → 无 tool_use？Stop hook → memory.autoExtract → 返回文本     │
└─────────────────────────────────────────────────────────────┘
```

## 权限管线（安全第一）

```
G0 规则合并   settings.json 多来源按优先级合并后判断：
             user < project < local < CLI < session（同级 deny > ask > allow）
G1 无条件层   bash/bg_run 危险模式（rm -rf /、sudo、shutdown…）→ 直接拒绝
             受保护路径（.claude/settings* / .mcp/* / .env / 密钥）写禁 + 密钥读禁
             （先于 settings allow 规则与 bypass 模式，agent 不得改自身权限/信任状态）
G2 完整分类   只读工具放行；bash 与 bg_run 共用完整命令分类器（commandClassifier）：
             引号感知分段（; && || | 子shell 逐段判断），禁止"只看第一个 token"；
             重定向目标越出工作区 → deny；.env/密钥读取 → deny；非只读段 → 转审批。
             classifier 钩子可换成 LLM 分类器（YOLO 模式）
G3 审批       ask 模式 → 终端 y/N（REPL 复用同一 readline）
             auto 模式 → 仅"明确 safe"自动放行，未知/危险命令仍转人工
             deny 模式 → 一律拒绝 / bypass 模式 → 显式全放行（风险自负）
```

纵深防御：即使权限层被绕过，`Sandbox` 仍会做 deny 检查、路径约束、超时、输出上限；
`bg_run`/`bash run_in_background` 与前台 bash 同一条管线（同 deny list、同分类、同超时/输出上限）；
文件工具在 `safePath` 词法检查之外再做 realpath 校验，拒绝 symlink/junction 逃逸；
`SANDBOX_CMD` 可以把命令整体送进 docker/WSL，`DOCKER_SANDBOX=1` 直接用 DockerSandbox 容器执行；
Windows 下 `pickShellArgs` 按命令内容自动选择 cmd.exe / powershell.exe（cmdlet 识别），
失败命令返回结构化错误（exit code + 输出尾部 + Hint + 禁止原样重试）。

外围安全：web 工具经 `urlguard` 做 SSRF 防护（私网/metadata/重定向逐跳校验 + 可选白名单）；
MCP 首次连接走信任门（展示命令 → 用户确认 → 完整配置指纹持久化到用户级 `~/.anvil/mcp-trusted.json`，
workspace 内 trusted.json 一律忽略）。

执行效率护栏：重复工具调用检测（同一调用连续 >2 次拦截）、单次 run 的 turn/工具调用/LLM 调用/输出 token
预算（80% 预警 + 硬上限）、prompt_too_long 连续压缩上限（3 次）、fallback 模型真正传给下一次 complete。

## 收敛保证（预算耗尽 → 最终报告模式）

长任务不收敛（真实审查曾出现 8 轮 12 次工具调用后只返回未完成句子）的兜底：

```
任一预算耗尽（turn / 工具调用 / LLM 调用 / 输出 token）
  → 进入最终报告模式：注入不可忽略的 <system-reminder>，LLM 调用单独限小 token（≤1500）
  → 模型仍调用工具？直接拦截返回错误结果（最多重试 2 次后强制结束）
  → 输出固定四部分：已完成检查 / 未完成检查 / 当前证据 / 风险项
  → messages + todos + readFileState + 报告 写入 checkpoint（可 /resume、/export）
```

配额类错误（Insufficient Balance / quota / 429 重试耗尽）走同一保活路径：捕获 → 保存 checkpoint →
输出结构化中断报告（含友好错误转译，不暴露 API 原文）→ REPL 存活。

## 子 Agent 成本预算

```
spawn_subagent
  ├─ 父任务全局账本（按父 session）：数量上限（默认 3）+ 工具调用总量 + 输出 token 总量
  │    超限 → 拒绝再派生（返回结构化提示，让父任务自行收尾）
  └─ 每个 subagent 独立预算：maxTurns / 工具调用 / LLM 调用 / 输出 token（SUBAGENT_MAX_*）
       超限 → agent 最终报告模式 → 返回结构化部分结论（不为空）
       输出统一压缩到 4000 字符（只留摘要 + file:line 证据 + 成本统计）
```

## 压缩管线（四层 + 应急）

| 层 | 触发 | 动作 | 成本 |
|---|---|---|---|
| L3 budget | 单条 user 消息 tool_result > 200KB | 大结果落盘 `.task_outputs/tool-results/`，留标记+2KB 预览 | 0 API |
| L1 snip | 消息数 > 50 | 保留头 3 + 尾 47，保护 tool_use/tool_result 配对 | 0 API |
| L2 micro | 旧 tool_result | 保留最近 3 条，其余换占位符 | 0 API |
| L4 摘要 | 仍超阈值 | 纯文本压缩 prompt（禁止工具 + `<analysis>/<summary>`） | 1 API |
| 应急 | prompt_too_long | reactiveCompact（保留更少尾部） | 1 API |

## 多 Agent 协作

- **MessageBus**：`.team/agents/<name>/inbox.jsonl`，append-only，drain-on-read。
- **协议**：request_id 配对 —— shutdown 握手、plan 审批门（send_plan_request / respond_plan）。
- **自治**：Teammate 状态机 WORK → IDLE → SHUTDOWN；空闲轮询任务看板，自动认领
  （`blockedBy` 全部完成才可 claim），完成即解锁下游。
- **隔离**：`git worktree add -b wt/<name>` + 任务绑定；工具 cwd 由 workdir 决定。

## MCP

- 真实 stdio JSON-RPC：`initialize → notifications/initialized → tools/list → tools/call`。
- 配置 `.mcp/servers.json`；连接后工具以 `mcp__server__tool` 注册进 ToolRegistry，
  下一轮 LLM 调用即可见（每轮都重新取 schemas）。

## 可观测性

- `.transcripts/<sessionId>.jsonl`：user_prompt / llm_call / tool_use / permission / compact / llm_error。
- `.audit/events.jsonl`：权限询问与 worktree 变更（敏感操作审计流）。
- 测试用 `MockLlm` 剧本驱动，断言 transcript 与消息序列，全程无网络。
