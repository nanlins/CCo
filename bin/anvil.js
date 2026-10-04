#!/usr/bin/env node
/**
 * 全局 CLI 入口 —— 在任何目录输入 `anvil` 或 `小锤` 启动。
 *
 * 通过 npm link / npm install -g 安装后，此文件成为全局命令。
 * 它会定位到项目源码目录，用项目自带的 node_modules 启动。
 *
 * 入口选择策略（resolveEntryMode）：
 *   - dist/main.js 缺失 → 回退源码（tsx）；
 *   - src 目录任一 .ts 文件比 dist/main.js 新 → 回退源码并告警；
 *   - ANVIL_USE_DIST=0 强制源码；ANVIL_USE_DIST=1 强制 dist（跳过 mtime）。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

/* ---------- 入口选择（纯函数，可单测） ---------- */

/**
 * 递归取目录下所有 .ts 文件的最大 mtime（毫秒时间戳）。
 * 仅用于比较"是否有 src 变更"；IO 失败返回 0（不阻断启动）。
 */
export function latestSrcMtime(srcDir, _fs = fs) {
  let latest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = _fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.ts')) {
        try {
          const mtime = _fs.statSync(full).mtimeMs;
          if (mtime > latest) latest = mtime;
        } catch {
          /* 并发删除不挂 */
        }
      }
    }
  };
  walk(srcDir);
  return latest;
}

/**
 * 解析入口模式。
 *
 * @param projectRoot 项目根目录
 * @param env 环境变量 map（process.env 或测试注入）
 * @param _fs 文件系统接口（可注入用于单测）
 * @returns {{ mode: 'dist' | 'src'; warning?: string }}
 */
export function resolveEntryMode(projectRoot, env, _fs = fs) {
  /* 用户显式强制 */
  if (env.ANVIL_USE_DIST === '0') return { mode: 'src' };
  if (env.ANVIL_USE_DIST === '1') return { mode: 'dist' };

  const distEntry = path.join(projectRoot, 'dist', 'main.js');
  const distExists = (() => {
    try {
      return _fs.existsSync(distEntry);
    } catch {
      return false;
    }
  })();

  /* dist 缺失 → 只能走源码 */
  if (!distExists) return { mode: 'src' };

  const distMtime = (() => {
    try {
      return _fs.statSync(distEntry).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const srcMtime = latestSrcMtime(path.join(projectRoot, 'src'), _fs);

  /* src 没有 .ts 文件读取到（项目结构异常，可能是安装目录），继续用 dist */
  if (srcMtime === 0) return { mode: 'dist' };

  if (srcMtime > distMtime) {
    return {
      mode: 'src',
      warning: '[anvil] dist 落后于 src，已回退源码模式；如需编译态请先 npm run build',
    };
  }

  return { mode: 'dist' };
}

/* ---------- 入口启动（仅直接执行时触发，不随 import 运行） ---------- */

/* 此文件在 bin/anvil.js，项目根在上一级 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/* 工作区 = 用户当前目录（让 agent 在"你所在的地方"工作） */
const userCwd = process.cwd();

/** 仅在作为入口脚本执行时（非 import/require/test）触发子进程启动。 */
function runCli() {
  const { mode, warning } = resolveEntryMode(PROJECT_ROOT, process.env);

  if (warning) console.warn(warning);

  const entry =
    mode === 'dist' ? path.join(PROJECT_ROOT, 'dist', 'main.js') : path.join(PROJECT_ROOT, 'src', 'main.ts');

  const child = spawn(process.execPath, mode === 'dist' ? [entry] : ['--import', 'tsx', entry], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      HARNESS_CWD: userCwd,
    },
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

/* 仅当此文件是 Node 命令行入口（如 `node bin/anvil.js` 或 `anvil` 全局命令）时才启动子进程；
   被 import（如测试）时只导出纯函数，不 spawn。 */
if (process.argv[1] && /bin[\\/]anvil/.test(process.argv[1])) {
  runCli();
}
