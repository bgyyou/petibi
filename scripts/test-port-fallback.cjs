// 【文件说明】端口占用顺延测试脚本（M4 内嵌 server 工单自验）
// 流程：
//   1. 用 Node net 模块占 127.0.0.1:8787
//   2. 启动 release/win-unpacked/Petibi.exe
//   3. 等 6 秒（足够 server 启动 + 顺延）
//   4. 用 netstat 看 Petibi 实际占用哪个端口（应该是 8788）
//   5. 命中 8788 端口返回 healthz OK
//   6. 关 Petibi + blocker，清理日志
const net = require('net')
const { exec, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const logFile = path.join(process.cwd(), 'logs', 'embed-fallback-test.log')
try { fs.unlinkSync(logFile) } catch {}

const blocker = net.createServer((sock) => sock.on('error', () => {}))
blocker.listen(8787, '127.0.0.1', () => {
  console.log('BLOCKER listening on 127.0.0.1:8787')

  // 启动 Petibi（后台）
  const exe = path.join(process.cwd(), 'release', 'win-unpacked', 'Petibi.exe')
  const args = [
    '--enable-logging',
    '--user-data-dir=C:\\Users\\19802\\AppData\\Local\\Temp\\petibi-fallback-test',
  ]
  const child = exec(`"${exe}" ${args.join(' ')} > "${logFile}" 2>&1`)
  child.on('error', (e) => console.log('exec err:', e.message))

  // 等待 6 秒后查看结果
  setTimeout(async () => {
    console.log('--- netstat ---')
    try {
      const out = execSync('netstat -ano | findstr :878 | findstr LISTENING').toString()
      console.log(out)
    } catch (e) {
      console.log('netstat err:', e.message)
    }

    console.log('--- log tail ---')
    try {
      const log = fs.readFileSync(logFile, 'utf-8')
      console.log(log.split('\n').slice(-15).join('\n'))
    } catch (e) {
      console.log('log read err:', e.message)
    }

    // 检测端口
    async function probe(port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`)
        return { port, status: res.status, body: await res.text() }
      } catch (e) {
        return { port, error: e.message }
      }
    }
    for (const p of [8787, 8788, 8789, 8790]) {
      const r = await probe(p)
      console.log(`probe ${p}:`, JSON.stringify(r))
    }

    // 清理
    try { execSync('taskkill /F /IM Petibi.exe', { stdio: 'ignore' }) } catch {}
    blocker.close()
    setTimeout(() => process.exit(0), 500)
  }, 6000)
})