// Vitest 配置：Node 环境 + ESM，测试文件统一放在 test/ 下（保留 src/ 子目录镜像结构）
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试运行环境：Node（无 DOM 需求）
    environment: 'node',
    // 测试文件匹配模式（统一放在 test/ 下，保留 src/ 子目录镜像结构）
    include: ['test/**/*.test.ts'],
    // 暂无测试时也允许通过（退出码 0）
    passWithNoTests: true,
    // v8 覆盖率
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
