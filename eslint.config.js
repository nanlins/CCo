// ESLint flat config —— TypeScript + Prettier 共存（格式化交给 Prettier，ESLint 只管代码质量）。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'py/**',
      'db/**',
      'assets/**',
      '.memory/**',
      '.tasks/**',
      '.team/**',
      '.transcripts/**',
      '.audit/**',
      '.vector_index/**',
      '.task_outputs/**',
      '.fs-test-*/**',
      /* 测试夹具：故意写成的"坏样本"（CommonJS/含缺陷），供审查任务使用 */
      'tests/fixtures/**',
      '**/*.py',
      'patch.mjs',
      'patch2.mjs',
      'test_terminal.js',
      'test_redis_verify.mts',
      'hello.md',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // 下划线前缀的参数/变量视为有意忽略；catch 绑定可省略
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 教学/演示代码允许显式 any（仍鼓励类型化，但不阻断）
      '@typescript-eslint/no-explicit-any': 'off',
      // 允许 catch {} 静默吞错（本项目大量"失败降级"语义）
      'no-empty': ['error', { allowEmptyCatch: true }],
      // for(;;) 事件循环是有意为之
      'no-constant-condition': ['error', { checkLoops: false }],
      // 允许在字符串/模板中使用控制字符（ANSI 转义序列）
      'no-control-regex': 'off',
    },
  },
  {
    // bin/ 下的纯 JS CLI：补 Node 全局变量
    files: ['bin/**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
  },
  {
    // 测试文件允许 node:test 全局
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
