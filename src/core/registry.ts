/**
 * 工具注册表 —— (schema, executor) 配对，加工具不加循环（s02 模式）。
 * MCP 连接后可以运行时注册新工具，agent 每轮调用前都会重新取 schemas。
 * 统一执行超时：防止单个工具卡死阻塞整个 agent 循环。
 */
import type { ToolContext, ToolDef, ToolSchema } from '../types.js';

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool '${toolName}' timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.tools.has(def.schema.name)) {
      throw new Error(`Tool already registered: ${def.schema.name}`);
    }
    this.tools.set(def.schema.name, def);
  }

  registerAll(defs: ToolDef[]): void {
    for (const def of defs) this.register(def);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  getSchemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const def = this.tools.get(name);
    if (!def) return `Error: Unknown tool '${name}'`;
    try {
      let validatedArgs = args;
      if (def.validator) {
        const result = def.validator.safeParse(args);
        if (!result.success) {
          return `Error: invalid arguments for ${name} — ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`;
        }
        validatedArgs = result.data;
      }
      const out = await withTimeout(
        Promise.resolve(def.executor(validatedArgs, ctx)),
        def.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        name,
      );
      return String(out);
    } catch (err) {
      return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** MCP / 动态工具移除（断连时清理）。 */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  isConcurrencySafe(name: string): boolean {
    return this.tools.get(name)?.concurrencySafe ?? false;
  }
}
