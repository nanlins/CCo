/**
 * 上下文/token 膨胀回归（P0-1）：长任务下输入 token 增长明显放缓。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactMessages, countMessageTokens, estimateTokens } from '../src/core/compact.js';
import type { Message } from '../src/types.js';

test('estimateTokens: CJK 计 1，ASCII 约 1/4', () => {
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('abcd'), 1);
});

test('compactMessages: 长任务下输入 token 增长明显放缓（非线性膨胀）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmp-'));
  const messages: Message[] = [];
  const sizes: number[] = [];

  for (let round = 0; round < 20; round++) {
    messages.push({ role: 'user', content: `第 ${round} 步：读取大文件` });
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `读取第 ${round} 个文件` },
        { type: 'tool_use', id: `t${round}`, name: 'read_file', input: { path: 'big.txt' } },
      ],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${round}`, content: 'X'.repeat(20_000) }],
    });
    const compacted = compactMessages(messages, { persistDir: dir });
    messages.length = 0;
    messages.push(...compacted);
    sizes.push(countMessageTokens(messages));
  }

  const last = sizes[sizes.length - 1];
  /* 未压缩线性增长约 20 × 20000/4 = 100k tokens；压缩后应显著更低 */
  assert.ok(last < 40_000, `最终 token 应受控，实际 ${last}`);
  /* 平台期：进入稳态后（第 6 轮起）到结束的增量应很小，而非线性继续涨 */
  assert.ok(sizes[5] < 40_000, `第 6 轮起应进入受控区间，实际 ${sizes[5]}`);
  assert.ok(last - sizes[5] < 10_000, `第 6→20 轮增量应受控（+${last - sizes[5]}），证明非线性膨胀`);

  fs.rmSync(dir, { recursive: true, force: true });
});
