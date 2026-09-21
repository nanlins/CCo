/**
 * Skill Loading —— 用到的时候才加载（s07 模式）。
 * 两级注入：system prompt 里只放目录（name + description），
 * load_skill 通过 tool_result 注入全文，不塞满上下文。
 * 扫描 workspace/skills 目录下所有 SKILL.md（frontmatter 免 yaml 依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from '../types.js';

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export class SkillLoader {
  private cache: Map<string, Skill> | null = null;

  constructor(private dir: string) {}

  private scan(): Map<string, Skill> {
    if (this.cache) return this.cache;
    const found = new Map<string, Skill>();
    if (fs.existsSync(this.dir)) {
      const stack: string[] = [this.dir];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name === 'SKILL.md') {
            const skill = parseSkillFile(full);
            if (skill) found.set(skill.name, skill);
          }
        }
      }
    }
    this.cache = found;
    return found;
  }

  refresh(): void {
    this.cache = null;
  }

  /** 目录（注入 system prompt）。 */
  catalog(): string {
    const skills = [...this.scan().values()];
    if (skills.length === 0) return '（无技能）';
    return `## Skills\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
  }

  load(name: string): string {
    const skill = this.scan().get(name);
    if (!skill) return `Error: unknown skill '${name}'. Available: ${[...this.scan().keys()].join(', ')}`;
    return `# Skill: ${skill.name}\n\n${skill.body}`;
  }
}

export function loadSkillTool(loader: SkillLoader): ToolDef {
  return {
    schema: {
      name: 'load_skill',
      description: '按名称加载技能的完整指令（见 system prompt 中的技能目录）。',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名' } },
        required: ['name'],
      },
    },
    executor: (args: Record<string, unknown>): string => {
      return loader.load(String(args.name ?? ''));
    },
  };
}

function parseSkillFile(file: string): Skill | null {
  const raw = fs.readFileSync(file, 'utf8');
  /* 先去除 BOM，再把 \r\n 与 \r 归一化为 \n，保证 frontmatter 解析跨平台/跨编辑器稳定 */
  const normalized = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        /* 元数据键允许前导空白：键值都 trim 后再记录 */
        const key = line.slice(0, idx).trim();
        if (key) meta[key] = line.slice(idx + 1).trim();
      }
    }
  }
  const name = meta.name ?? '';
  const description = meta.description ?? '';
  const body = m ? m[2].trim() : normalized;
  if (!name || !description) return null;
  return { name, description, body };
}
