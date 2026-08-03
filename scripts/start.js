// 智能启动脚本：产物缺失时才构建（server tsc / web vite build），避免每次 start 都重新编译前端。
// 根 package.json 无 "type" 字段（默认 CJS），故本文件使用 CommonJS 语法。
// 用法：
//   node scripts/start.js            智能构建后启动（产物存在则直接启动，跳过构建）
//   node scripts/start.js --rebuild  强制全量构建（pnpm build）后启动
//   node scripts/start.js --check    仅检查产物存在性并打印结果，不构建不启动（可加 --rebuild 一起看）
const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const SERVER_ENTRY = join(ROOT, 'server/dist/index.js')
const WEB_ENTRY = join(ROOT, 'web/dist/index.html')

const rebuild = process.argv.includes('--rebuild')
const check = process.argv.includes('--check')

const run = (args, label) => {
  console.log(`[start] ${label}`)
  const r = spawnSync('pnpm', args, { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (check) {
  console.log(`[check] server 产物 ${existsSync(SERVER_ENTRY) ? '存在' : '缺失'}: ${SERVER_ENTRY}`)
  console.log(`[check] web 产物   ${existsSync(WEB_ENTRY) ? '存在' : '缺失'}: ${WEB_ENTRY}`)
  if (rebuild) console.log('[check] --rebuild：启动时会强制全量构建')
  process.exit(0)
}

if (rebuild) {
  run(['build'], '全量构建（--rebuild）')
} else {
  if (!existsSync(SERVER_ENTRY)) run(['--filter', '@llmproxy/server', 'build'], 'server 产物缺失，构建 server...')
  if (!existsSync(WEB_ENTRY)) run(['--filter', '@llmproxy/web', 'build'], 'web 产物缺失，构建 web...')
}

// 前台启动服务（阻塞直到退出）
// 除 --check / --rebuild 外的启动参数（如 --host/--port）原样透传给 server 进程
const serverArgs = process.argv.slice(2).filter((a) => a !== '--check' && a !== '--rebuild')
console.log('[start] 启动服务 node server/dist/index.js')
const s = spawnSync(process.execPath, [join(ROOT, 'server/dist/index.js'), ...serverArgs], { cwd: ROOT, stdio: 'inherit' })
process.exit(s.status ?? 0)
