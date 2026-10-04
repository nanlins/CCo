/**
 * 持久化写入降级工具。
 *
 * 职责：持久化层（transcript / audit / memory 等）写入失败时只告警一次，
 *       绝不抛出——工作区只读/磁盘满时降级为内存态，不中断 agent.run。
 */

let warned = false;

/** 执行写入；失败告警一次并返回 false（不抛出）。 */
export function safeWrite(fn: () => void, what: string): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    if (!warned) {
      warned = true;
      process.stderr.write(
        `[警告] ${what}写入失败（工作区可能不可写），已降级为内存态：${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    return false;
  }
}

/** 测试用：重置告警去重标志。 */
export function resetSafeWriteWarning(): void {
  warned = false;
}

// 修改记录：
//   2026-10-03 新增：持久化写失败降级（只告警一次、不抛出）
