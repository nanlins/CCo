/**
 * P1-2 回归：独立完成判定层真正生效（verifiers/commandResults 不再死代码）。
 *
 * 覆盖：
 *   - evaluateGoal 对 fileExists 的未满足/满足判定；
 *   - commandExit0 按最近一次退出码判定（重试成功以最后一次为准）；
 *   - /goal 显式登记验证器；
 *   - bash 工具真实执行后写入 session.commandResults；
 *   - Stop 闸门接入 verifier 后确实阻塞未完成任务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateGoal } from '../src/core/goalJudge.js';
import { handleGoalCommand } from '../src/core/goalCommands.js';
import { makeHarness } from './helpers.js';

test('P1-2: fileExists 验证器未满足 → 未完成；文件存在后 → 完成', () => {
  const h = makeHarness();
  try {
    const verifiers = [{ kind: 'fileExists', path: 'out.txt' } as const];
    const before = evaluateGoal({ goal: '创建 out.txt', todos: [], verifiers, ctx: { workdir: h.workdir } });
    assert.equal(before.complete, false);
    assert.match(before.reason, /out\.txt/);
    fs.writeFileSync(path.join(h.workdir, 'out.txt'), 'x');
    const after = evaluateGoal({ goal: '创建 out.txt', todos: [], verifiers, ctx: { workdir: h.workdir } });
    assert.equal(after.complete, true);
  } finally {
    h.cleanup();
  }
});

test('P1-2: commandExit0 按最近一次退出码判定（重试成功以末次为准）', () => {
  const h = makeHarness();
  try {
    const verifiers = [{ kind: 'commandExit0', command: 'node x.js' } as const];
    const fail = evaluateGoal({
      goal: 'g',
      todos: [],
      verifiers,
      ctx: { workdir: h.workdir, commandResults: [{ command: 'node x.js', exitCode: 1 }] },
    });
    assert.equal(fail.complete, false);
    const retried = evaluateGoal({
      goal: 'g',
      todos: [],
      verifiers,
      ctx: {
        workdir: h.workdir,
        commandResults: [
          { command: 'node x.js', exitCode: 1 },
          { command: 'node x.js', exitCode: 0 },
        ],
      },
    });
    assert.equal(retried.complete, true, '最近一次退出码 0 应判完成');
    const missing = evaluateGoal({ goal: 'g', todos: [], verifiers, ctx: { workdir: h.workdir } });
    assert.equal(missing.complete, false, '无命令记录不得判完成');
  } finally {
    h.cleanup();
  }
});

test('P1-2: /goal 登记写入 session.verifiers（file/contains/command/clear）', () => {
  const h = makeHarness();
  try {
    const s = h.session;
    assert.match(handleGoalCommand(s, []), /无验证器/);
    handleGoalCommand(s, ['file', 'out.txt']);
    handleGoalCommand(s, ['contains', 'log.txt', 'done', 'ok']);
    handleGoalCommand(s, ['command', 'node', 'check.js']);
    assert.equal(s.verifiers?.length, 3);
    assert.deepEqual(s.verifiers?.[0], { kind: 'fileExists', path: 'out.txt' });
    assert.deepEqual(s.verifiers?.[1], { kind: 'fileContains', path: 'log.txt', text: 'done ok' });
    assert.deepEqual(s.verifiers?.[2], { kind: 'commandExit0', command: 'node check.js' });
    const listed = handleGoalCommand(s, ['list']);
    assert.match(listed, /file_exists: out\.txt/);
    assert.match(handleGoalCommand(s, ['clear']), /已清空/);
    assert.deepEqual(s.verifiers, []);
  } finally {
    h.cleanup();
  }
});

test('P1-2: bash 工具真实执行后写入 commandResults（含非零退出码）', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'bash', input: { command: 'node -e "process.exit(3)"' } }] },
      { blocks: [{ type: 'text', text: 'done' }] },
    ],
  });
  try {
    await h.agent.run('执行会失败的命令');
    const results = h.session.commandResults ?? [];
    assert.ok(
      results.some((r) => r.command.includes('process.exit(3)') && r.exitCode === 3),
      `应记录真实退出码 3: ${JSON.stringify(results)}`,
    );
  } finally {
    h.cleanup();
  }
});

test('P1-2: Stop 闸门接入 verifier 后确实阻塞未完成任务', async () => {
  const h = makeHarness({
    script: [
      { blocks: [{ type: 'tool_use', name: 'write_file', input: { path: 'partial.txt', content: 'x' } }] },
      { blocks: [{ type: 'text', text: 'claim done' }] },
      { blocks: [{ type: 'text', text: 'still done claim' }] },
    ],
  });
  let stopChecks = 0;
  let blockedOnce = false;
  h.hooks.register('Stop', () => {
    stopChecks += 1;
    const j = evaluateGoal({
      goal: 'g',
      todos: h.session.todos,
      verifiers: h.session.verifiers,
      ctx: { workdir: h.workdir, commandResults: h.session.commandResults },
    });
    if (j.complete) return undefined;
    blockedOnce = true;
    return { blockingError: j.reason };
  });
  try {
    /* 要求 out.txt 存在，但任务只创建了 partial.txt → Stop 必须阻塞 */
    h.session.verifiers = [{ kind: 'fileExists', path: 'out.txt' }];
    await h.agent.run('创建 out.txt');
    assert.ok(stopChecks >= 2, `Stop 闸门应阻塞并重试（实际检查 ${stopChecks} 次）`);
    assert.equal(blockedOnce, true, '缺少 out.txt 时不得判完成');
  } finally {
    h.cleanup();
  }
});
