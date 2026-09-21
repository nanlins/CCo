/**
 * Docker 沙箱 —— 在容器中执行命令（安全隔离）。
 *
 * 功能：
 *   1. 在 Docker 容器中执行 bash 命令（隔离文件系统/网络/进程）
 *   2. 支持自定义镜像（默认 node:20-alpine）
 *   3. 超时控制 + 输出上限
 *   4. 可选：挂载工作区目录
 *
 * 使用场景：
 *   - 执行不可信代码（模型生成的脚本）
 *   - 运行需要特定环境的命令（Python/Node/编译工具）
 *   - 隔离危险操作（rm/format 等）
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface DockerSandboxOptions {
  /** Docker 镜像（默认 node:20-alpine）。 */
  image?: string;
  /** 超时（毫秒，默认 60s）。 */
  timeoutMs?: number;
  /** 输出上限（字符，默认 50000）。 */
  maxOutputChars?: number;
  /** 是否挂载工作区目录。 */
  mountWorkdir?: boolean;
  /** 网络模式（默认 none，隔离网络）。 */
  network?: string;
  /** 内存限制（默认 512m）。 */
  memory?: string;
}

export class DockerSandbox {
  private opts: Required<DockerSandboxOptions>;

  constructor(opts: DockerSandboxOptions = {}) {
    this.opts = {
      image: opts.image ?? 'node:20-alpine',
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxOutputChars: opts.maxOutputChars ?? 50_000,
      mountWorkdir: opts.mountWorkdir ?? false,
      network: opts.network ?? 'none',
      memory: opts.memory ?? '512m',
    };
  }

  /** 检查 Docker 是否可用。 */
  async isAvailable(): Promise<boolean> {
    try {
      const child = spawn('docker', ['info'], { stdio: 'ignore' });
      const [code] = (await once(child, 'close')) as [number | null];
      return code === 0;
    } catch {
      return false;
    }
  }

  /** 在容器中执行命令。 */
  async run(command: string, workdir?: string): Promise<{ output: string; exitCode: number }> {
    const args = buildDockerRunArgs(this.opts, command, workdir);

    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), this.opts.timeoutMs);

    let out = '';
    const max = this.opts.maxOutputChars;
    const collect = (chunk: Buffer) => {
      if (out.length < max) out += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const [code] = (await once(child, 'close')) as [number | null];
    clearTimeout(timer);

    const truncated = out.length >= max;
    return {
      output: truncated ? out.slice(0, max) + '\n...[output truncated]' : out.trim(),
      exitCode: code ?? 1,
    };
  }

  /** 在容器中执行 Python 代码。 */
  async runPython(code: string): Promise<{ output: string; exitCode: number }> {
    return this.run(`python3 -c ${JSON.stringify(code)}`, undefined);
  }

  /** 在容器中执行 Node.js 代码。 */
  async runNode(code: string): Promise<{ output: string; exitCode: number }> {
    return this.run(`node -e ${JSON.stringify(code)}`, undefined);
  }
}

/**
 * 纯函数：构造 `docker run` 参数（供单测，无需真实 docker）。
 * 与 DockerSandbox.run 共用，保证测试覆盖的就是线上逻辑。
 */
export function buildDockerRunArgs(opts: Required<DockerSandboxOptions>, command: string, workdir?: string): string[] {
  const args: string[] = ['run', '--rm', `--memory=${opts.memory}`, `--network=${opts.network}`, '--cpus=1'];
  if (opts.mountWorkdir && workdir) {
    args.push('-v', `${workdir}:/workspace`, '-w', '/workspace');
  }
  args.push(opts.image, 'sh', '-c', command);
  return args;
}
