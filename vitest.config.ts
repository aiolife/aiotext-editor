import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // src/ 下是应用代码的单测；tests/ 下是交付形态的契约与阈值检查（见 packaging.test.ts）
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    reporters: 'default',
  },
});
