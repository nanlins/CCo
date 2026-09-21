/**
 * 回归：技能加载的 BOM / 换行 / frontmatter 鲁棒性。
 *   - BOM 头、CRLF、CR 混合换行的 SKILL.md 都必须能正常进入 catalog；
 *   - frontmatter 元数据键允许前导空白。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillLoader } from '../src/tools/skills.js';

function mkSkillsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skills-'));
}

test('BOM + CRLF 的 SKILL.md 能进入 catalog', () => {
  const dir = mkSkillsDir();
  try {
    /* BOM + CRLF 行尾 */
    const content = '\uFEFF---\r\nname: claude-code-review\r\ndescription: 代码审查技能\r\n---\r\n\r\n# 审查流程\r\n';
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    const loader = new SkillLoader(dir);
    const catalog = loader.catalog();
    assert.ok(catalog.includes('claude-code-review'), `catalog 应含 claude-code-review:\n${catalog}`);
    const loaded = loader.load('claude-code-review');
    assert.ok(loaded.includes('# 审查流程'), '正文应正确解析');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CRLF（无 BOM）与 CR（旧 Mac）混合换行都能解析', () => {
  const dir = mkSkillsDir();
  try {
    /* CRLF，无 BOM */
    fs.mkdirSync(path.join(dir, 'review-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'review-agent', 'SKILL.md'),
      '---\r\nname: review-agent\r\ndescription: 审查代理\r\n---\r\n\r\n正文A\r\n',
      'utf8',
    );
    /* 旧式 CR 行尾 + 元数据键前导空白 */
    fs.mkdirSync(path.join(dir, 'codex-security'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'codex-security', 'SKILL.md'),
      '---\r  name: codex-security\r  description: 安全审查\r---\r\r正文B\r',
      'utf8',
    );
    const loader = new SkillLoader(dir);
    const catalog = loader.catalog();
    assert.ok(catalog.includes('review-agent'), `catalog 应含 review-agent:\n${catalog}`);
    assert.ok(catalog.includes('codex-security'), `catalog 应含 codex-security:\n${catalog}`);
    assert.ok(loader.load('review-agent').includes('正文A'));
    assert.ok(loader.load('codex-security').includes('正文B'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('三个 fixture 技能（claude-code-review / review-agent / codex-security）全部进入 catalog', () => {
  const dir = mkSkillsDir();
  try {
    fs.mkdirSync(path.join(dir, 'claude-code-review'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'review-agent'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'codex-security'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'claude-code-review', 'SKILL.md'),
      '\uFEFF---\r\nname: claude-code-review\r\ndescription: 代码评审\r\n---\r\n\r\n内容\r\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'review-agent', 'SKILL.md'),
      '---\nname: review-agent\ndescription: 评审代理\n---\n\n内容\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'codex-security', 'SKILL.md'),
      '---\r\nname: codex-security\r\ndescription: 安全审查\r\n---\r\n\r\n内容\r\n',
      'utf8',
    );
    const loader = new SkillLoader(dir);
    const catalog = loader.catalog();
    for (const name of ['claude-code-review', 'review-agent', 'codex-security']) {
      assert.ok(catalog.includes(name), `catalog 必须包含 ${name}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
