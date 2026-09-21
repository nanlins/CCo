/**
 * 回归：证据可信度（item 9）。
 *   - read_file lineNumbers=true 返回完整源路径 + 行号前缀；
 *   - grep / list_files 返回完整源路径；
 *   - 报告校验器只接受能追溯到工具结果的行号，无法验证的标记"未验证"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsTools } from '../src/tools/fs.js';
import { validateEvidence } from '../src/core/evidence.js';
import type { ToolContext, Message } from '../src/types.js';

function ctx(workdir: string): ToolContext {
  return { workdir } as never;
}
function tool(name: string) {
  const def = fsTools().find((t) => t.schema.name === name);
  assert.ok(def, `tool ${name} not found`);
  return def!;
}

test('read_file lineNumbers=true：返回 [source] 头 + 行号前缀', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ev-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'lineA\nlineB\nlineC', 'utf8');
    const out = String(await tool('read_file').executor({ path: 'a.ts', lineNumbers: true }, ctx(dir)));
    assert.ok(out.includes(`[source: ${path.join(dir, 'a.ts')}`), `应含完整源路径头，实际: ${out}`);
    assert.ok(out.includes('1|lineA'), `应含行号前缀: ${out}`);
    assert.ok(out.includes('3|lineC'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('grep / list_files 返回完整源路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ev-'));
  try {
    fs.writeFileSync(path.join(dir, 'x.ts'), 'const foo = 1', 'utf8');
    const fullPath = path.join(dir, 'x.ts').split(path.sep).join('/');
    const grep = String(await tool('grep').executor({ pattern: 'foo', path: 'x.ts' }, ctx(dir)));
    assert.ok(grep.includes(fullPath), `grep 应含完整路径: ${grep}`);
    const list = String(await tool('list_files').executor({}, ctx(dir)));
    assert.ok(list.includes(fullPath), `list_files 应含完整路径: ${list}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateEvidence：只接受来自工具结果的行号，无法验证的标记未验证', () => {
  const dir = '/repo';
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'r1',
          content: `[source: ${dir}/server.js]\n1|const x = 1\n2|const y = 2\n3|const z = 3`,
        },
        {
          type: 'tool_result',
          tool_use_id: 'g1',
          content: `${dir}/auth.js:5: const secret = 1`,
        },
      ],
    },
  ];
  /* 报告引用了：server.js:2（已验证）、auth.js:5（已验证）、server.js:99（未验证） */
  const report = '发现 server.js:2 的问题；auth.js:5 也很可疑；另外 server.js:99 待确认。';
  const v = validateEvidence(report, messages);
  assert.ok(v.verified.includes('server.js:2'), `server.js:2 应已验证: ${JSON.stringify(v.verified)}`);
  assert.ok(v.verified.includes('auth.js:5'));
  assert.ok(v.unverified.includes('server.js:99'), `server.js:99 应未验证: ${JSON.stringify(v.unverified)}`);
  assert.equal(v.unverified.length, 1);
});
