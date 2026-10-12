# scripts：交付验证脚本

## 用途

存放可复现的交付质量脚本（干净副本验收等），供本地与 CI 使用。

## 内容清单

| 文件                     | 说明                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `verify-clean-clone.ps1` | Windows：复制工作区（排除 node_modules/dist/.env/日志/运行期状态）并执行全链路验收 |
| `verify-clean-clone.sh`  | Linux/macOS：同上（tar 复制 + npm 全链路 + CLI smoke）                             |

全链路步骤：`npm ci` → `typecheck` → `lint` → `format:check` → `test` → `build` → `node dist/main.js --version`。

## 修改记录

- 2026-10-12：新增干净副本验收脚本（PowerShell / sh 双版本）。
