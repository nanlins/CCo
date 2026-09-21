import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalHashEmbedder } from '../src/rag/embedding.js';
import { InMemoryVectorStore } from '../src/rag/vectorStore.js';
import { RagService } from '../src/tools/rag.js';
import { collectDocs, chunkFile } from '../src/rag/chunker.js';

function makeRag(root: string): RagService {
  const persistDir = path.join(root, '.vector_index');
  const embedder = new LocalHashEmbedder();
  return new RagService({
    root,
    embedder,
    store: new InMemoryVectorStore(persistDir),
    stateFile: path.join(persistDir, 'state.json'),
  });
}

function makeDocDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rag-'));
  fs.writeFileSync(
    path.join(dir, 'guide.md'),
    '# 配置指南\n\n## API Key\n\n把 ANTHROPIC_API_KEY 填到 .env 文件。\n\n## 模型\n\nMODEL_ID 决定使用哪个模型。\n',
  );
  fs.writeFileSync(path.join(dir, 'other.txt'), '与主题无关的内容。\n');
  fs.writeFileSync(path.join(dir, 'hello.md'), '# 欢迎\n\n这是一个示例文档。\n');
  return dir;
}

test('index: 构建索引并统计块数', async () => {
  const dir = makeDocDir();
  const rag = makeRag(dir);
  const r = await rag.index();
  assert.ok(r.indexed >= 3, `期望至少 3 块，实际 ${r.indexed}`);
  assert.ok(r.total >= 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('search: 向量检索命中相关内容并带来源', async () => {
  const dir = makeDocDir();
  const rag = makeRag(dir);
  await rag.index();
  const result = await rag.search('如何配置 API Key？');
  assert.ok(result.includes('guide.md:'));
  assert.ok(result.includes('ANTHROPIC_API_KEY'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('search: 无命中时明确拒绝，不编造', async () => {
  const dir = makeDocDir();
  const rag = makeRag(dir);
  await rag.index();
  const result = await rag.search('量子计算与图论');
  assert.ok(result.includes('未找到相关内容'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('search: 未索引时给出提示', async () => {
  const dir = makeDocDir();
  const rag = makeRag(dir);
  const result = await rag.search('API Key');
  assert.ok(result.includes('未找到相关内容') || result.includes('索引'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('index: 增量更新跳过未变更文件', async () => {
  const dir = makeDocDir();
  const rag = makeRag(dir);
  const r1 = await rag.index();
  assert.ok(r1.indexed > 0, `首次索引应建立文档，实际 ${r1.indexed}`);
  const r2 = await rag.index();
  assert.equal(r2.indexed, 0, `第二次应全部跳过，实际 ${r2.indexed}`);
  // 修改一个文件后，只索引该文件
  fs.writeFileSync(path.join(dir, 'hello.md'), '# 欢迎\n\n新内容。\n'.repeat(5));
  const r3 = await rag.index();
  assert.ok(r3.indexed >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chunker: 按标题分块并保留行号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chunk-'));
  const f = path.join(dir, 'a.md');
  fs.writeFileSync(f, '# 标题一\n\n内容 A\n\n## 标题二\n\n内容 B\n');
  const chunks = chunkFile(f);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].heading.includes('标题一'));
  assert.ok(chunks[1].heading.includes('标题二'));
  assert.ok(chunks[0].startLine >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectDocs: 跳过 node_modules', () => {
  const dir = makeDocDir();
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'skip.md'), '# x\n');
  const files = collectDocs(dir);
  assert.ok(!files.some((f) => f.includes('node_modules')));
  fs.rmSync(dir, { recursive: true, force: true });
});
