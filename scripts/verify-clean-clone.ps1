<#
用途：干净副本验收 —— 复制工作区（排除 node_modules / dist / .env / 日志 / 运行期状态 / 嵌套 .git），
      在副本中执行：npm ci → typecheck → lint → format:check → test → build → CLI smoke。
      验证"陌生开发者可复现"，不依赖本机残留产物。

用法（PowerShell）：
  powershell -File scripts/verify-clean-clone.ps1
  powershell -File scripts/verify-clean-clone.ps1 -Source D:\repo -Dest E:\clean-verify-CCo

退出码：0 = 全绿；非 0 = 首个失败步骤的退出码。
修改记录：
  2026-10-12 新增（交付质量：干净副本闭环验证）
#>
param(
  [string]$Source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Dest = (Join-Path $env:TEMP 'clean-verify-cco')
)

$ErrorActionPreference = 'Stop'

# 1) 复制：排除产物与敏感/运行期文件（robocopy 退出码 0-7 均为成功）
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
$xd = @(
  'node_modules', 'dist', '.git', '.memory', '.tasks', '.team', '.transcripts',
  '.task_outputs', '.cron', '.audit', '.vector_index', '.mcp', '.workflow', '.idea', '.husky'
)
$xf = @('.env', '*.log', '*.tgz')
robocopy $Source $Dest /E /XD @xd /XF @xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（exit=$LASTEXITCODE）" }

Push-Location $Dest
try {
  Write-Host "== clean copy: $Dest (source: $Source)"
  Write-Host "== node $(node -v) / npm $(npm.cmd -v)"

  function Invoke-Step([string]$Name, [scriptblock]$Cmd) {
    Write-Host "== $Name"
    & $Cmd
    if ($LASTEXITCODE -ne 0) { throw "步骤失败: $Name (exit=$LASTEXITCODE)" }
  }

  Invoke-Step 'npm ci' { npm.cmd ci }
  Invoke-Step 'typecheck' { npm.cmd run typecheck }
  Invoke-Step 'lint' { npm.cmd run lint }
  Invoke-Step 'format:check' { npm.cmd run format:check }
  Invoke-Step 'test' { npm.cmd test }
  Invoke-Step 'build' { npm.cmd run build }
  Invoke-Step 'cli --version' { node dist/main.js --version }

  Write-Host 'ALL GREEN'
} finally {
  Pop-Location
}
