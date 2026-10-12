# docs：设计与交付文档索引

> 用途：CCo 的工程文档总索引；所有文档内的数字/结论以 [verified-claims.md](verified-claims.md) 的来源为准。

| 文档                                         | 内容                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [architecture.md](architecture.md)           | 架构设计：循环、模块数据流、权限/压缩管线、多 Agent、MCP、可观测 |
| [performance.md](performance.md)             | 性能相关设计与实测                                               |
| [prompt-design.md](prompt-design.md)         | Prompt 结构、Few-shot、输出控制、修改前后对比                    |
| [rag-pgvector.md](rag-pgvector.md)           | 向量检索架构、PostgreSQL 部署、表设计                            |
| [workflow-vs-agent.md](workflow-vs-agent.md) | 固定工作流 vs 自主 Agent 的取舍                                  |
| [ops-runbook.md](ops-runbook.md)             | 运维手册：安装/启动/健康检查/故障/回滚                           |
| [failure-modes.md](failure-modes.md)         | 失败路径：用户可见行为/日志字段/数据影响/恢复/测试               |
| [verified-claims.md](verified-claims.md)     | 已验证结论：命令/环境/结果/commit SHA/日期                       |
| [review-checklist.md](review-checklist.md)   | 交付自审清单                                                     |

## 修改记录

- 2026-10-12：从一行说明扩展为文档索引；登记运维手册/失败模式/已验证结论/自审清单。
