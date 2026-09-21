/**
 * bash 工具 —— 命令走 Sandbox（deny list + 超时 + 输出上限 + 可选容器包装）。
 * cwd 跟随 workdir（worktree 隔离场景自动切换）。
 * 支持 run_in_background 参数：慢操作放后台，立即返回任务 ID。
 * DOCKER_SANDBOX=1 时命令送进 Docker 容器执行（隔离文件系统/网络/进程）。
 *
 * 纵深防御：执行器层再查一次 deny list 与完整命令分类（重定向逃逸等），
 * 即使权限层被绕过也不会执行。
 */
import { z } from 'zod';
import { Sandbox } from '../core/sandbox.js';
import { DockerSandbox } from '../core/dockerSandbox.js';
import { classifyShellCommand } from '../core/commandClassifier.js';
import type { ToolContext, ToolDef } from '../types.js';
import type { BackgroundSystem } from './background.js';

const bashSchema = z.object({
  command: z.string().min(1, 'command cannot be empty'),
  run_in_background: z.boolean().optional(),
});

export function bashTool(bg?: BackgroundSystem): ToolDef {
  return {
    schema: {
      name: 'bash',
      description:
        '在工作区执行 shell 命令（沙箱保护，120s 超时，输出截断）。Windows 下自动识别 PowerShell cmdlet 并选择对应 shell；路径含空格请加双引号。慢操作可设 run_in_background=true。',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          run_in_background: { type: 'boolean', description: '慢操作放后台执行（返回任务 id）', default: false },
        },
        required: ['command'],
      },
    },
    validator: bashSchema,
    executor: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const command = String(args.command ?? '');
      if (!command.trim()) return 'Error: empty command';

      /* 无论前台/后台，先过 deny list（纵深防御，后台路径不得绕过沙箱） */
      const blocked = Sandbox.blockedByDenyList(command);
      if (blocked) return `Error: ${blocked}`;

      /* 纵深防御：完整命令分类（重定向目标越出工作区等）直接拒绝 */
      const cls = classifyShellCommand(command, ctx.workdir);
      if (cls.verdict === 'deny') return `Error: ${cls.reason}`;

      if (args.run_in_background && bg) {
        const id = bg.start(command);
        return `[Background task ${id} started] Poll with bg_check.`;
      }

      /* Docker 沙箱：DOCKER_SANDBOX=1 时命令在容器内执行（挂载工作区） */
      if (ctx.config.dockerSandbox) {
        const docker = new DockerSandbox({
          mountWorkdir: true,
          timeoutMs: 120_000,
          maxOutputChars: ctx.config.maxToolOutputChars,
        });
        if (!(await docker.isAvailable())) {
          return 'Error: DOCKER_SANDBOX=1 但 docker 不可用（未安装或未启动）。请安装 Docker 或移除 DOCKER_SANDBOX。';
        }
        const { output, exitCode } = await docker.run(command, ctx.workdir);
        if (exitCode !== 0) return `Error: command exited with code ${exitCode}\n${output}`;
        return output || '（无输出）';
      }

      const sandbox = new Sandbox({
        cwd: ctx.workdir,
        sandboxCmd: ctx.config.sandboxCmd,
        maxOutputChars: ctx.config.maxToolOutputChars,
      });
      return sandbox.run(command);
    },
  };
}
