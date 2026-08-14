// 【文件说明】极端端口占用测试（M4 内嵌 server 工单自验）
// 占 8787-8790 共 4 个端口，验证 server 顺延机制走完后再让系统分配端口。
const net = require('net')
const { exec, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const logFile = path.join(process.cwd(), 'logs', 'embed-extreme-test.log')
try { fs.unlinkSync(logFile) } catch {}

const blockedPorts = [8787, 8788, 8789, 8790]
const blockers = []

blockedPorts.forEach((p, idx) => {
  const b = net.createServer((sock) => sock.on('error', () => {}))
  b.listen(p, '127.0.0.1', () => {
    console.log(`BLOCKER ${idx} listening on 127.0.0.1:${p}`)
    if (idx === blockedPorts.length - 1) {
      // 全部 block 后启动 Petibi
      const exe = path.join(process.cwd(), 'release', 'win-unpacked', 'Petibi.exe')
      const args = [
        '--enable-logging',
        '--user-data-dir=C:\\Users\\19802\\AppData\\Local\\Temp\\petibi-extreme-test',
      ]
      const child = exec(`"${exe}" ${args.join(' ')} > "${logFile}" 2>&1`)
      child.on('error', (e) => console.log('exec err:', e.message))

      setTimeout(async () => {
        console.log('--- netstat ---')
        try {
          const out = execSync('netstat -ano | findstr LISTENING').toString()
          const lines = out.split('\n').filter(l => l.includes(':878') || l.includes('Petibi'))
          console.log(lines.join('\n'))
        } catch (e) { console.log('netstat err:', e.message) }

        console.log('--- log tail ---')
        try {
          const log = fs.readFileSync(logFile, 'utf-8')
          console.log(log.split('\n').slice(-15).join('\n'))
        } catch (e) { console.log('log read err:', e.message) }

        // 探测
        for (const p of blockedPorts) {
          try {
            const res = await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(1000) })
            console.log(`probe ${p}: ${res.status} ${await res.text()}`)
          } catch (e) { console.log(`probe ${p}: ${e.message}`) }
        }

        try { execSync('taskkill /F /IM Petibi.exe', { stdio: 'ignore' }) } catch {}
        blockers.forEach(b => b.close())
        setTimeout(() => process.exit(0), 500)
      }, 6000)
    }
  })
  blockers.push(b)
})