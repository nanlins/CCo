# tests/acceptance

> 用途：真实 LLM 受控验收脚本（密钥只经环境变量传入，不写 .env、不提交）。

## 内容清单

| 文件 | 说明 |
|---|---|
| `openclaw-review.ts` | 代码审查验收：预算内收敛 + 预算耗尽强制四段式结构化报告 |
| `nanoclaw-review.ts` | 只读研究任务验收：交付检查表（Q1-Q4）+ 证据文件覆盖 + 运行约束判定 |
| `plan-execute.ts` | 先规划再执行实测：打印轨迹并判定"先规划 or 直接上手" |
| `*-last-output.txt` | 最近一次验收的最终输出（落盘备查，无密钥） |

运行：`npm run acceptance:openclaw` / `acceptance:nanoclaw` / `acceptance:plan`（需 `$env:OPENAI_API_KEY`）。

## 修改记录

- 2026-08-24：新建目录；补 README。
