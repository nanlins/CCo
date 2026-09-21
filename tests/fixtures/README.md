# tests/fixtures

> 用途：验收/评估用的样本项目（故意植入缺陷或特定结构），供真实 LLM 受控验收读取。

## 内容清单

| 目录 | 说明 |
|---|---|
| `openclaw-review/` | 故意植入缺陷的样本项目（`server.js` eval/SQL 注入/硬编码密钥、`db.js` 凭据泄露、`auth.js` 弱哈希），供 `acceptance:openclaw` 审查 |

## 修改记录

- 2026-08-24：新建目录；补 README。
