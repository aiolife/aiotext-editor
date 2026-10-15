import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      // Rust/Tauri 构建产物（workspace target 在根目录 target/，含 tauri 生成的临时 js）
      'target/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs['recommended-latest'],
  {
    rules: {
      // 迭代计数等场景允许 _ 前缀占位变量
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['vite.config.ts', 'vitest.config.ts', 'scripts/**/*.mjs', '*.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        // 冒烟脚本用的是 Node 内置能力：fetch（≥18）与全局 WebSocket（≥22.4）
        fetch: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
