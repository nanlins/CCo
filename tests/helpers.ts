/** 测试装配：临时工作区 + MockLlm + auto 权限，全程无网络。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MockLlm, type ScriptedTurn } from '../src/llm/mock.js';
import { Agent } from '../src/core/agent.js';
import { HookRegistry } from '../src/core/hooks.js';
import { PermissionGate } from '../src/core/permission.js';
import { ToolRegistry } from '../src/core/registry.js';
import { Transcript } from '../src/core/transcript.js';
import { MemoryStore } from '../src/core/memory.js';
import { standardTools } from '../src/tools/index.js';
import { TaskSystem } from '../src/tools/tasks.js';
import type { Session } from '../src/types.js';

export interface TestHarness {
  agent: Agent;
  llm: MockLlm;
  registry: ToolRegistry;
  hooks: HookRegistry;
  permission: PermissionGate;
  session: Session;
  workdir: string;
  cleanup: () => void;
}

export function makeHarness(
  opts: {
    script?: ScriptedTurn[];
    permissionMode?: 'ask' | 'auto' | 'deny' | 'bypass';
    ask?: (q: string) => Promise<boolean>;
    /** 额外配置覆盖（预算/上限等测试用）。 */
    configOverrides?: Partial<AppConfig>;
  } = {},
): TestHarness {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const config = loadConfig({
    workspaceDir: workdir,
    mock: true,
    permissionMode: opts.permissionMode ?? 'auto',
    ...opts.configOverrides,
  });
  const llm = new MockLlm({ script: opts.script });
  const session: Session = {
    id: 'test-session',
    cwd: workdir,
    baseSystem: 'You are a test agent.',
    messages: [],
    todos: [],
    startTime: Date.now(),
  };
  const permission = new PermissionGate({
    mode: opts.permissionMode ?? 'auto',
    ask: opts.ask ?? (async () => false),
  });
  const registry = new ToolRegistry();
  const tasks = new TaskSystem(path.join(workdir, '.tasks'));
  registry.registerAll(standardTools({ tasks, ownerName: 'test' }));
  const hooks = new HookRegistry();
  const agent = new Agent({
    config,
    llm,
    registry,
    hooks,
    permission,
    session,
    transcript: new Transcript(path.join(workdir, '.transcripts'), 'test'),
    memory: new MemoryStore(path.join(workdir, '.memory')),
    ask: async () => false,
    log: () => {},
    autoMemory: false,
  });
  return {
    agent,
    llm,
    registry,
    hooks,
    permission,
    session,
    workdir,
    cleanup: () => fs.rmSync(workdir, { recursive: true, force: true }),
  };
}

/** 给输出流补上终端尺寸（columns/rows），供 REPL 测试显式模拟终端大小。 */
export function setTerminalSize(output: NodeJS.WritableStream, columns = 80, rows = 24): void {
  Object.assign(output, { columns, rows });
}
