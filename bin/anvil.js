#!/usr/bin/env node
/**
 * 全局 CLI 入口 —— 在任何目录输入 `anvil` 或 `小锤` 启动。
 *
 * 通过 npm link / npm install -g 安装后，此文件成为全局命令。
 * 它会定位到项目源码目录，用项目自带的 node_modules 启动。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

/* 此文件在 bin/anvil.js，项目根在上一级 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/* 工作区 = 用户当前目录（让 agent 在"你所在的地方"工作） */
const userCwd = process.cwd();

/* 使用 tsx 启动（开发模式，兼容源码）或编译后的 dist（生产模式） */
const useDist = process.env.ANVIL_USE_DIST === '1';
const entry = useDist ? path.join(PROJECT_ROOT, 'dist', 'main.js') : path.join(PROJECT_ROOT, 'src', 'main.ts');

/* cwd 用项目根（解析 tsx/node_modules），工作区用用户当前目录 */
const child = spawn(process.execPath, useDist ? [entry] : ['--import', 'tsx', entry], {
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
