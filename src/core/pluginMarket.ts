/**
 * Plugin 市场 —— skill/plugin 发现 + 安装机制。
 *
 * 功能：
 *   1. 扫描本地 skills/ 目录发现可用 plugin
 *   2. 从远程 registry 搜索 plugin（预留接口）
 *   3. 安装 plugin（下载到 skills/ 目录）
 *   4. 卸载 plugin
 *   5. 列出已安装 plugin
 *
 * Plugin 格式：
 *   skills/<name>/SKILL.md       — 技能描述（frontmatter: name/description）
 *   skills/<name>/plugin.json    — 插件元数据（可选）
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PluginInfo {
  name: string;
  description: string;
  version?: string;
  author?: string;
  installed: boolean;
  path?: string;
}

export interface PluginManifest {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tools?: string[];
  dependencies?: string[];
}

export class PluginMarket {
  private skillsDir: string;

  constructor(workspaceDir: string) {
    this.skillsDir = path.join(workspaceDir, 'skills');
    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  /** 扫描本地已安装的 plugin。 */
  listInstalled(): PluginInfo[] {
    if (!fs.existsSync(this.skillsDir)) return [];
    const plugins: PluginInfo[] = [];
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginPath = path.join(this.skillsDir, entry.name);
      const info = this.readPluginInfo(pluginPath);
      if (info) {
        plugins.push({ ...info, installed: true, path: pluginPath });
      }
    }
    return plugins;
  }

  /** 读取 plugin 信息。 */
  private readPluginInfo(pluginPath: string): PluginInfo | null {
    /* 优先读 plugin.json */
    const manifestPath = path.join(pluginPath, 'plugin.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
        return {
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          author: manifest.author,
          installed: true,
        };
      } catch {
        /* 损坏则回退到 SKILL.md */
      }
    }

    /* 回退：读 SKILL.md frontmatter */
    const skillPath = path.join(pluginPath, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (match) {
          const meta: Record<string, string> = {};
          for (const line of match[1].split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
          return {
            name: meta.name ?? path.basename(pluginPath),
            description: meta.description ?? '',
            installed: true,
          };
        }
      } catch {
        /* 解析失败 */
      }
    }

    return null;
  }

  /** 远程 registry 环境变量（指向 JSON 索引）。 */
  static readonly REGISTRY_ENV = 'ANVIL_PLUGIN_REGISTRY';

  /** 目标是否位于目录内（防路径穿越）。 */
  private static insideDir(root: string, target: string): boolean {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private registryUrl(): string | undefined {
    const url = process.env[PluginMarket.REGISTRY_ENV]?.trim();
    return url || undefined;
  }

  /** 远程 registry 状态（供 /plugins /plugin-search 展示，避免"看起来能用"的死入口）。 */
  registryStatus(): { configured: boolean; url?: string; hint: string } {
    const url = this.registryUrl();
    if (!url) {
      return {
        configured: false,
        hint: `未配置远程 registry：设置环境变量 ${PluginMarket.REGISTRY_ENV}=<JSON 索引 URL> 后启用远程搜索；本地安装用 /plugin-install <路径>。`,
      };
    }
    return { configured: true, url, hint: `远程 registry: ${url}` };
  }

  /**
   * 搜索远程 plugin。registry 未配置 → 返回空数组（调用方用 registryStatus().hint 提示）；
   * 配置后真实拉取 JSON 索引并按 name/description 过滤。
   */
  async searchRegistry(query: string): Promise<PluginInfo[]> {
    const url = this.registryUrl();
    if (!url) return [];
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`registry 请求失败: HTTP ${resp.status}`);
    const data = (await resp.json()) as unknown;
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { plugins?: unknown[] })?.plugins)
        ? (data as { plugins: unknown[] }).plugins
        : [];
    const q = query.trim().toLowerCase();
    const installed = new Set(this.listInstalled().map((p) => p.name));
    return list
      .map((p) => p as Record<string, unknown>)
      .filter(
        (p) =>
          !q ||
          String(p.name ?? '')
            .toLowerCase()
            .includes(q) ||
          String(p.description ?? '')
            .toLowerCase()
            .includes(q),
      )
      .map((p) => ({
        name: String(p.name ?? ''),
        description: String(p.description ?? ''),
        version: p.version !== undefined ? String(p.version) : undefined,
        author: p.author !== undefined ? String(p.author) : undefined,
        installed: installed.has(String(p.name ?? '')),
      }));
  }

  /** 安装 plugin（从 URL 或本地路径）。 */
  async install(source: string): Promise<{ success: boolean; message: string }> {
    /* 本地路径安装 */
    if (fs.existsSync(source)) {
      const name = path.basename(source);
      const targetPath = path.join(this.skillsDir, name);
      if (fs.existsSync(targetPath)) {
        return { success: false, message: `Plugin '${name}' already installed` };
      }
      try {
        fs.cpSync(source, targetPath, { recursive: true });
        return { success: true, message: `Installed '${name}' from local path` };
      } catch (err) {
        return { success: false, message: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    /* 远程安装：JSON 插件包 { name, description?, files: { "<相对路径>": "<内容>" } } */
    if (/^https?:\/\//.test(source)) {
      if (!source.endsWith('.json')) {
        return {
          success: false,
          message: `远程安装仅支持 JSON 插件包（URL 以 .json 结尾）；当前: ${source}。也可用本地路径安装。`,
        };
      }
      try {
        const resp = await fetch(source, { signal: AbortSignal.timeout(20_000) });
        if (!resp.ok) return { success: false, message: `下载失败: HTTP ${resp.status}` };
        const pack = (await resp.json()) as { name?: unknown; files?: unknown };
        const name = String(pack.name ?? '').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          return { success: false, message: `插件包 name 非法（仅允许字母数字._-）: ${name || '(空)'}` };
        }
        if (!pack.files || typeof pack.files !== 'object') {
          return { success: false, message: '插件包缺少 files 映射（需 {name, files:{"SKILL.md":"…"}}）' };
        }
        const targetPath = path.join(this.skillsDir, name);
        if (fs.existsSync(targetPath)) return { success: false, message: `Plugin '${name}' already installed` };
        const entries = Object.entries(pack.files as Record<string, unknown>);
        /* 先全量校验路径，任一越界即拒绝（防 ../ 穿越） */
        for (const [rel] of entries) {
          if (!PluginMarket.insideDir(targetPath, path.resolve(targetPath, rel))) {
            return { success: false, message: `插件包含越界路径，已拒绝: ${rel}` };
          }
        }
        fs.mkdirSync(targetPath, { recursive: true });
        for (const [rel, content] of entries) {
          const dest = path.resolve(targetPath, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, String(content), 'utf8');
        }
        return { success: true, message: `Installed '${name}' from URL（${entries.length} 个文件）` };
      } catch (err) {
        return { success: false, message: `远程安装失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    return { success: false, message: `未知来源: ${source}（支持本地路径或 http(s) JSON 插件包 URL）` };
  }

  /** 卸载 plugin。名称可以是安装目录名，也可以是 manifest/SKILL.md 里的显示名。 */
  uninstall(name: string): { success: boolean; message: string } {
    /* 1) 先按目录名直接匹配 */
    let pluginPath = path.join(this.skillsDir, name);
    if (!fs.existsSync(pluginPath)) {
      /* 2) 再按显示名（manifest name / SKILL.md frontmatter name）查找 */
      const hit = this.listInstalled().find((p) => p.name === name && p.path);
      if (!hit?.path) {
        return { success: false, message: `Plugin '${name}' not found（既非目录名也非显示名）` };
      }
      pluginPath = hit.path;
    }
    try {
      fs.rmSync(pluginPath, { recursive: true, force: true });
      return { success: true, message: `Uninstalled '${name}' (${path.basename(pluginPath)})` };
    } catch (err) {
      return { success: false, message: `Uninstall failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 获取 plugin 详情。名称可以是安装目录名，也可以是显示名。 */
  getDetails(name: string): PluginInfo | null {
    const pluginPath = path.join(this.skillsDir, name);
    if (fs.existsSync(pluginPath)) return this.readPluginInfo(pluginPath);
    const hit = this.listInstalled().find((p) => p.name === name);
    return hit ?? null;
  }
}
