import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compactMessages, compactHistory, snipCompact, microCompact } from '../src/core/compact.js';
import { ReadFileState } from '../src/core/readFileState.js';
import { fsTools } from '../src/tools/fs.js';
import { MockLlm } from '../src/llm/mock.js';
import type { Message } from '../src/types.js';

function msg(role: 'user' | 'assistant', content: Message['content']): Message {
  return { role, content };
}

test('snip keeps head and tail and never splits tool_use/tool_result pairs', () => {
  const messages: Message[] = [];
  messages.push(msg('user', 'start'));
  messages.push(msg('user', 'a'));
  // 把一对工具调用恰好放在头边界附近（head=3 处会切开）
  messages.push(msg('assistant', [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo 1' } }]));
  messages.push(msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'out 1' }]));
  for (let i = 4; i < 58; i++) messages.push(msg('user', `m${i}`));
  const out = snipCompact(messages, {
    maxMessages: 50,
    keepHead: 3,
    keepRecentToolResults: 3,
    maxToolResultChars: 200000,
    thresholdChars: 50000,
    persistDir: '.',
  });
  assert.ok(out.length <= 52, `out.length=${out.length}`); // 边界保护最多 +2
  const placeholder = out.find((m) => typeof m.content === 'string' && m.content.includes('snipped'));
  assert.ok(placeholder, 'expected snip placeholder');
  // 配对完整性：任一 tool_use 与其 tool_result 必须同侧（同留或同裁）
  const kept = new Set<number>();
  const headEnd = out.findIndex((m) => typeof m.content === 'string' && m.content.includes('snipped'));
  const tailStart = headEnd + 1;
  for (let i = 0; i < headEnd; i++) kept.add(i);
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' || b.type === 'tool_result') {
        // 只校验"保留侧"的配对：head 内的 tool_use 必须有对应 result 也在 head 内
        if (i < headEnd && b.type === 'tool_use') {
          const next = out[i + 1];
          assert.ok(
            Array.isArray(next?.content) && next.content.some((x) => x.type === 'tool_result'),
            `orphan tool_use at ${i}`,
          );
        }
        if (i >= tailStart && b.type === 'tool_result') {
          const prev = out[i - 1];
          assert.ok(
            Array.isArray(prev?.content) && prev.content.some((x) => x.type === 'tool_use'),
            `orphan tool_result at ${i}`,
          );
        }
      }
    }
  }
  void kept;
});

test('snip terminates on pure tool-pair sequences (stress)', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 60; i++) {
    messages.push(msg('assistant', [{ type: 'tool_use', id: `t${i}`, name: 'bash', input: { command: `echo ${i}` } }]));
    messages.push(msg('user', [{ type: 'tool_result', tool_use_id: `t${i}`, content: `out ${i}` }]));
  }
  const out = snipCompact(messages, {
    maxMessages: 50,
    keepHead: 3,
    keepRecentToolResults: 3,
    maxToolResultChars: 200000,
    thresholdChars: 50000,
    persistDir: '.',
  });
  assert.ok(out.length < messages.length, 'should compact something');
});

test('micro keeps recent 3 tool results and compacts the rest', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 5; i++) {
    messages.push(msg('user', [{ type: 'tool_result', tool_use_id: `r${i}`, content: 'x'.repeat(500) }]));
  }
  const out = microCompact(messages, {
    keepRecentToolResults: 3,
    maxMessages: 50,
    keepHead: 3,
    maxToolResultChars: 200000,
    thresholdChars: 50000,
    persistDir: '.',
  });
  const blocks = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const compacted = blocks.filter((b) => b.type === 'tool_result' && b.content.includes('compacted'));
  const full = blocks.filter((b) => b.type === 'tool_result' && b.content.length > 400);
  assert.equal(compacted.length, 2);
  assert.equal(full.length, 3);
});

test('budget persists large tool results to disk', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.compact-test-'));
  try {
    const big = 'B'.repeat(100_000);
    const messages: Message[] = [
      msg('assistant', [{ type: 'tool_use', id: 'big1', name: 'bash', input: { command: 'cat big' } }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'big1', content: big }]),
    ];
    const actions: string[] = [];
    const out = compactMessages(messages, {
      thresholdChars: 50000,
      persistDir: dir,
      maxToolResultChars: 10_000,
      onAction: (a) => actions.push(a),
    });
    const persisted = fs.readdirSync(dir).filter((f) => f.startsWith('tool_result_'));
    assert.ok(persisted.length >= 1);
    const block = (Array.isArray(out[out.length - 1].content) ? out[out.length - 1].content : [])[0];
    assert.ok(block.type === 'tool_result' && block.content.includes('<persisted-output'));
    assert.ok(actions.some((a) => a.includes('persisted')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compactHistory produces summary message + tail', async () => {
  const llm = new MockLlm({
    script: [
      {
        blocks: [{ type: 'text', text: '<analysis>a</analysis>\n<summary>THE SUMMARY</summary>' }],
      },
    ],
  });
  const messages: Message[] = [];
  for (let i = 0; i < 20; i++) messages.push(msg('user', `message ${i}`));
  const result = await compactHistory(messages, llm, { maxTokens: 1000, keepRecentMessages: 5 });
  assert.equal(result.summary, 'THE SUMMARY');
  assert.equal(result.messages[0].content, '[Conversation compacted. Summary:\nTHE SUMMARY]');
  assert.equal(result.messages.length, 6); // summary + 5 tail
});

test('micro preserves knowledge tool results (read_file/pdf_parsing) — 防止"读了后面忘了前面"', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 5; i++) {
    messages.push(
      msg('assistant', [{ type: 'tool_use', id: `r${i}`, name: 'read_file', input: { path: `doc${i}.md` } }]),
    );
    messages.push(msg('user', [{ type: 'tool_result', tool_use_id: `r${i}`, content: `# Doc ${i} `.repeat(50) }]));
  }
  const out = microCompact(messages, {
    keepRecentToolResults: 3,
    maxMessages: 50,
    keepHead: 3,
    maxToolResultChars: 200000,
    thresholdChars: 50000,
    persistDir: '.',
  });
  const blocks = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const compacted = blocks.filter((b) => b.type === 'tool_result' && b.content.includes('compacted'));
  assert.equal(compacted.length, 0, 'read_file 结果不应被 L2 压缩');
  const full = blocks.filter((b) => b.type === 'tool_result' && b.content.includes('# Doc'));
  assert.equal(full.length, 5, '所有 read_file 结果都应保留原文');
});

test('snip 裁掉 read_file 内容时标记 evicted —— 重读返回全文而非 stub（实测 sess_1786299904107 T39 事故回归）', async () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.compact-test-'));
  try {
    const file = path.join(dir, 'doc.md');
    fs.writeFileSync(file, 'Z'.repeat(3000));

    const messages: Message[] = [];
    messages.push(msg('user', 'task start'));
    messages.push(msg('user', 'more context'));
    messages.push(msg('user', 'even more'));
    for (let i = 0; i < 10; i++) messages.push(msg('user', `lead-in ${i}`));
    /* read_file 对放在中段（head=3 之外、tail 之前），确保被 snip 裁掉 */
    messages.push(msg('assistant', [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'doc.md' } }]));
    messages.push(msg('user', [{ type: 'tool_result', tool_use_id: 'r1', content: fs.readFileSync(file, 'utf8') }]));
    for (let i = 0; i < 55; i++) messages.push(msg('user', `filler ${i}`));

    const rfs = new ReadFileState();
    rfs.markRead(file);
    const out = snipCompact(messages, {
      maxMessages: 50,
      keepHead: 3,
      keepRecentToolResults: 3,
      maxToolResultChars: 200000,
      thresholdChars: 50000,
      persistDir: '.',
      readFileState: rfs,
      baseDir: dir,
    });
    // read_file 对位于中段，应被裁掉
    const stillThere = out.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && b.content.includes('ZZZ')),
    );
    assert.ok(!stillThere, 'read_file 内容应已被 snip 裁掉');
    assert.ok(rfs.isEvicted(file), '被裁掉的 read_file 必须标记 evicted');

    // 重读必须返回全文而不是 stub
    const readDef = fsTools().find((t) => t.schema.name === 'read_file')!;
    const reread = await readDef.executor({ path: 'doc.md' }, { workdir: dir, readFileState: rfs } as never);
    assert.ok(typeof reread === 'string' && reread.includes('ZZZ'), '重读应返回完整内容');
    assert.ok(!reread.includes('[File unchanged since last read]'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('阈值闸门：总字符超 thresholdChars 时主动落盘大结果（0 API，防 prompt_too_long）', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.compact-test-'));
  try {
    const big = 'Q'.repeat(40_000);
    const messages: Message[] = [
      msg('user', 'start'),
      msg('assistant', [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'cat big' } }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'b1', content: big }]),
      msg('assistant', [{ type: 'tool_use', id: 'b2', name: 'bash', input: { command: 'cat big2' } }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'b2', content: big }]),
    ];
    const actions: string[] = [];
    compactMessages(messages, {
      thresholdChars: 50_000, // 总量 ~80k > 50k → 应触发落盘
      persistDir: dir,
      maxToolResultChars: 200_000, // 单批通道不触发，验证的是阈值通道
      onAction: (a) => actions.push(a),
    });
    const persisted = fs.readdirSync(dir).filter((f) => f.startsWith('tool_result_'));
    assert.ok(persisted.length >= 1, '阈值通道应落盘至少一个大结果');
    assert.ok(actions.some((a) => a.includes('[compact L3]')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('阈值闸门不落盘知识类结果（防"循环持久化"回归：read_file 被落盘→模型绕道 bash）', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.compact-test-'));
  try {
    const messages: Message[] = [
      msg('user', 'start'),
      msg('assistant', [{ type: 'tool_use', id: 'k1', name: 'read_file', input: { path: 'doc.md' } }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'k1', content: 'K'.repeat(40_000) }]),
    ];
    const actions: string[] = [];
    compactMessages(messages, {
      thresholdChars: 10_000, // 总量 40k > 10k，但唯一的大结果是 read_file
      persistDir: dir,
      maxToolResultChars: 200_000,
      onAction: (a) => actions.push(a),
    });
    const persisted = fs.readdirSync(dir).filter((f) => f.startsWith('tool_result_'));
    assert.equal(persisted.length, 0, '知识类结果不应被阈值通道落盘');
    const block = (Array.isArray(messages[2].content) ? messages[2].content : [])[0];
    assert.ok(block.type === 'tool_result' && block.content.includes('KKKK'), 'read_file 原文应保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('阈值闸门仍会落盘非知识类大结果（bash 输出）', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.compact-test-'));
  try {
    const messages: Message[] = [
      msg('user', 'start'),
      msg('assistant', [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'cat big' } }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'b1', content: 'B'.repeat(40_000) }]),
    ];
    compactMessages(messages, {
      thresholdChars: 10_000,
      persistDir: dir,
      maxToolResultChars: 200_000,
    });
    const persisted = fs.readdirSync(dir).filter((f) => f.startsWith('tool_result_'));
    assert.ok(persisted.length >= 1, 'bash 大输出应被落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('microCompact 只统计真正被压缩的结果（不虚报 knowledge/已压缩项）', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 5; i++) {
    messages.push(
      msg('assistant', [{ type: 'tool_use', id: `k${i}`, name: 'read_file', input: { path: `d${i}.md` } }]),
    );
    messages.push(msg('user', [{ type: 'tool_result', tool_use_id: `k${i}`, content: 'y'.repeat(500) }]));
  }
  const actions: string[] = [];
  microCompact(messages, {
    keepRecentToolResults: 3,
    maxMessages: 50,
    keepHead: 3,
    maxToolResultChars: 200000,
    thresholdChars: 50000,
    persistDir: '.',
    onAction: (a) => actions.push(a),
  });
  assert.equal(actions.length, 0, '全是 knowledge 结果时不应报告 compacted');
});

test('readFileState: L3 落盘移除后，重读返回完整内容而非 stub（修复信息永久丢失陷阱）', async () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.compact-test-'));
  try {
    const file = path.join(dir, 'doc.md');
    fs.writeFileSync(file, 'D'.repeat(40_000));
    const big = fs.readFileSync(file, 'utf8');

    const messages: Message[] = [
      msg('assistant', [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'doc.md' } }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'r1', content: big }]),
    ];
    const rfs = new ReadFileState();
    rfs.markRead(file);

    compactMessages(messages, {
      thresholdChars: 50000,
      persistDir: dir,
      maxToolResultChars: 10_000,
      readFileState: rfs,
      baseDir: dir,
    });
    assert.ok(rfs.isEvicted(file), 'L3 落盘后应标记 evicted');

    // 重读：内容应被恢复，而不是返回 stub
    const readDef = fsTools().find((t) => t.schema.name === 'read_file')!;
    const out = await readDef.executor({ path: 'doc.md' }, { workdir: dir, readFileState: rfs } as never);
    assert.ok(typeof out === 'string' && out.includes('D'.repeat(100)), '重读应返回完整内容');
    assert.ok(!out.includes('[File unchanged since last read]'));
    assert.ok(!rfs.isEvicted(file), '重读后应清除 evicted 标记');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
