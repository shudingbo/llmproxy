// ESLint 扁平配置：typescript-eslint 严格推荐规则集
// eslint.config.js 位于包根目录，按 ESM（"type": "module"）加载
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 构建产物与覆盖率报告不参与检查
    ignores: ['dist/', 'coverage/'],
  },
  // typescript-eslint 官方严格规则集（含 recommended 全部规则 + 更严格约束）
  ...tseslint.configs.strict,
)
