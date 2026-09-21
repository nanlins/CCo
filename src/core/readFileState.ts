/**
 * ReadFileState —— 重复读取未变化文件时返回 FILE_UNCHANGED_STUB。
 * 按 mtime + size 判断文件是否变化，避免重复读大文件浪费 token。
 * 与子 agent 共享（CC 中 readFileState 从父克隆），同一实例跨 agent 复用。
 */
import fs from 'node:fs';

export const FILE_UNCHANGED_STUB = '[File unchanged since last read]';

interface CachedEntry {
  mtimeMs: number;
  size: number;
}

export class ReadFileState {
  private cache = new Map<string, CachedEntry>();
  /** 内容已从上下文中被压缩/落盘抹除的文件路径。重读时应返回完整内容而非 stub。 */
  private evicted = new Set<string>();

  /** 检查是否自上次读取后未变化。 */
  isUnchanged(filePath: string): boolean {
    try {
      const stat = fs.statSync(filePath);
      const entry = this.cache.get(filePath);
      if (!entry) return false;
      return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
    } catch {
      return false;
    }
  }

  /** 标记某文件的内容已被压缩/落盘移除，下次重读必须返回完整内容。 */
  markEvicted(filePath: string): void {
    this.evicted.add(filePath);
  }

  /** 该文件的内容是否已被移除出上下文。 */
  isEvicted(filePath: string): boolean {
    return this.evicted.has(filePath);
  }

  /** 重读返回完整内容后清除 eviction 标记。 */
  clearEvicted(filePath: string): void {
    this.evicted.delete(filePath);
  }

  /** 读取成功后再标记缓存。 */
  markRead(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      this.cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // 文件不存在则清除缓存
      this.cache.delete(filePath);
    }
  }

  /** 清除某个文件（或全部）的缓存。 */
  invalidate(filePath?: string): void {
    if (filePath) {
      this.cache.delete(filePath);
      this.evicted.delete(filePath);
    } else {
      this.cache.clear();
      this.evicted.clear();
    }
  }

  /** 导出已读文件路径（供会话快照持久化，/resume 时恢复）。 */
  snapshot(): string[] {
    return [...this.cache.keys()];
  }

  /** 从快照恢复已读状态（mtime/size 在下次 isUnchanged 时按当时磁盘状态校验）。 */
  restore(paths: string[]): void {
    for (const p of paths) {
      if (!this.cache.has(p)) this.markRead(p);
    }
  }
}
