/**
 * i18n 多语言支持 —— 中英文切换。
 * 启动时读取 ANVIL_LANG（zh|en），运行时用 /lang 命令切换（见 main.ts）。
 */

export type Locale = 'zh' | 'en';

const messages: Record<Locale, Record<string, string>> = {
  zh: {
    'app.name': '小锤 Anvil',
    'app.tagline': '手搓 Agent Harness · 机制很多，循环一个',
    'app.welcome': '你好，我是小锤(Anvil)——一个从零手搓的 AI 编程助手。想让我做什么？',
    'input.placeholder': '输入任务，如：列出所有 Python 文件并总结',
    'button.send': '发送',
    'status.thinking': '思考中...',
    'status.executing': '正在执行',
    'sidebar.tools': '可用工具',
    'sidebar.token': 'Token',
    'theme.dark': '🌙 深色',
    'theme.light': '☀️ 浅色',
    'permission.allow': '允许',
    'permission.deny': '拒绝',
    'permission.ask': '是否允许?',
    'error.tool_failed': '工具执行失败',
    'error.permission_denied': '权限被拒绝',
    'compact.session_memory': 'session-memory 复用（0 API）',
    'compact.reactive': 'reactive compact after prompt_too_long',
    'router.flash': 'flash 模型',
    'router.pro': 'pro 模型',
    'router.default': '默认路由',
    'redis.cache_hit': '工具缓存命中',
    'repl.badge.you': '你',
    'repl.badge.permission': '权限请求',
    'repl.cancel_requested': '[取消请求] 正在等待当前步骤结束后退出…',
    'repl.exit_hint': '(再按一次 Ctrl+C 退出；输入 /exit 也可以)',
    'repl.error': '[错误]',
  },
  en: {
    'app.name': 'Anvil',
    'app.tagline': 'Hand-rolled Agent Harness · Many mechanisms, one loop',
    'app.welcome': 'Hi, I am Anvil — a hand-rolled AI coding assistant. What can I do for you?',
    'input.placeholder': 'Enter a task, e.g., list all Python files and summarize',
    'button.send': 'Send',
    'status.thinking': 'Thinking...',
    'status.executing': 'Executing',
    'sidebar.tools': 'Available Tools',
    'sidebar.token': 'Token',
    'theme.dark': '🌙 Dark',
    'theme.light': '☀️ Light',
    'permission.allow': 'Allow',
    'permission.deny': 'Deny',
    'permission.ask': 'Allow?',
    'error.tool_failed': 'Tool execution failed',
    'error.permission_denied': 'Permission denied',
    'compact.session_memory': 'session-memory reuse (0 API)',
    'compact.reactive': 'reactive compact after prompt_too_long',
    'router.flash': 'flash model',
    'router.pro': 'pro model',
    'router.default': 'default routing',
    'redis.cache_hit': 'tool cache hit',
    'repl.badge.you': 'You',
    'repl.badge.permission': 'Permission',
    'repl.cancel_requested': '[cancel requested] waiting for the current step to finish…',
    'repl.exit_hint': '(press Ctrl+C again to exit, or type /exit)',
    'repl.error': '[Error]',
  },
};

const envLocale = (process.env.ANVIL_LANG ?? '').toLowerCase();
let currentLocale: Locale = envLocale === 'en' ? 'en' : 'zh';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: string): string {
  return messages[currentLocale][key] ?? messages.zh[key] ?? key;
}
