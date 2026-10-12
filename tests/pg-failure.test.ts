/**
 * 失败路径回归：PostgreSQL 不可用时降级不崩溃。
 *
 * 覆盖（docs/failure-modes.md #5）：
 *   - PgVectorStore 连接不可用 → init() 拒绝（由工具层捕获转为用户可见的"检索失败/索引失败"）；
 *   - 构造与 close 不抛异常（创建 store 本身不阻塞启动）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PgVectorStore } from '../src/rag/vectorStore.js';

test('PG 不可用：PgVectorStore.init 拒绝而非崩溃，close 安全', async () => {
  const store = new PgVectorStore({
    connectionString: 'postgres://postgres:x@127.0.0.1:1/ai_agent',
    dims: 8,
  });
  await assert.rejects(() => store.init(), '连接不可用时应拒绝（而不是抛未捕获异常）');
  store.close();
});
