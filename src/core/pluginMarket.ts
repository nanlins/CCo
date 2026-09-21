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

  /** 搜索远程 plugin（预留接口，当前返回空）。 */
  async searchRegistry(_query: string): Promise<PluginInfo[]> {
    /* TODO: 实现远程 registry 搜索 */
    return [];
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

    /* URL 安装（预留） */
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return { success: false, message: 'Remote install not implemented yet' };
    }

    return { success: false, message: `Unknown source: ${source}` };
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
