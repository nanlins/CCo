# tests：测试清单

> 用途：测试目录说明。测试总数与覆盖率以实测为准（见 `docs/verified-claims.md`；2026-10-12 实测：402 个测试断言/用例，0 失败）。

- `tests/*.test.ts`：单元/集成测试（node:test + MockLlm，无网络依赖），覆盖主循环、权限、压缩、钩子、双协议、RAG、MCP、REPL 等。
- `tests/acceptance/`：真实 LLM 受控验收脚本（需要密钥环境变量，未设置时明确 SKIP）。
- `tests/eval/`：评估场景与运行器（`npm run eval`）。
- `tests/perf/`：性能基准（`npm run bench`）。
- `tests/fixtures/`：测试夹具（如植入缺陷的样本项目）。

## 修改记录

- 2026-10-12：更新过期测试数量（133 → 402，指向 verified-claims）；补充目录说明。
