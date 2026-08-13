// 【文件说明】Petibi 桌宠主进程：创建透明无边框悬浮窗，处理拖拽位移与右键状态菜单的 IPC（M1 工单 / 红线 R2）
import { join } from 'path'
import { BrowserWindow, Menu, app, ipcMain } from 'electron'

// electron-vite 在 dev 模式下注入的渲染进程 dev-server 地址；打包后该变量为空，改走本地文件
const devUrl = process.env['ELECTRON_RENDERER_URL']

// 桌宠唯一窗口的引用（M1 只有一只桌宠，用模块级变量即可）
let win: BrowserWindow | null = null

// 当前动画状态，仅用于右键菜单的单选勾选显示；真实播放状态在渲染进程维护
let currentState: 'idle' | 'blink' | 'happy' = 'idle'

/**
 * 创建桌宠悬浮窗。
 * 关键属性（工单技术决策）：
 *   transparent 透明背景（壁纸透出来）、frame:false 无边框、
 *   alwaysOnTop 置顶、resizable:false 固定 128×128（32×32 sprite 放大 4 倍，PRD §8.4 新画布规范）、
 *   skipTaskbar 不进任务栏、hasShadow:false 避免透明窗阴影残边。
 */
function createWindow(): void {
  win = new BrowserWindow({
    width: 128,
    height: 128,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      // 预加载脚本：以 contextBridge 暴露最小 API，渲染进程不直接持有 Node 能力
      preload: join(__dirname, '../preload/preload.js'),
      // 桌宠窗常年无焦点/被遮挡，Chromium 默认会把 setInterval 钳制到 1Hz，
      // 导致 8fps 动画变成 1fps；必须关掉后台节流（实测验证过该现象）
      backgroundThrottling: false,
    },
  })

  // 桌宠是全屏应用之外的装饰窗口，被关闭时直接退出整个应用
  win.on('closed', () => {
    win = null
    app.quit()
  })

  if (devUrl) {
    // dev：加载 electron-vite 的渲染热更新服务
    win.loadURL(devUrl)
  } else {
    // 打包后：加载构建产物里的静态页面
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 注册 IPC：拖拽位移 + 右键状态菜单 */
function registerIpc(): void {
  // 拖拽：渲染进程把"鼠标在屏幕上移动的增量 (dx, dy)"发过来，
  // 主进程在当前窗口位置基础上叠加（透明窗不能用 -webkit-app-region:drag，工单已定）
  ipcMain.on('pet:drag', (_event, dx: number, dy: number) => {
    if (!win) return
    const [x, y] = win.getPosition()
    // screenX/screenY 本身是整数，增量取整后直接叠加，避免累积小数漂移
    win.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  // 渲染进程回告状态变化（键盘切换等不经过菜单的途径），保持菜单单选勾选与实际一致
  ipcMain.on('pet:state-changed', (_event, state: 'idle' | 'blink' | 'happy') => {
    currentState = state
  })

  // 右键菜单：弹出三状态单选菜单（调试用切换动画状态），点击后回发渲染进程
  ipcMain.on('pet:menu', () => {
    if (!win) return
    const states: Array<{ id: 'idle' | 'blink' | 'happy'; label: string }> = [
      { id: 'idle', label: '待机 idle' },
      { id: 'blink', label: '眨眼 blink' },
      { id: 'happy', label: '开心 happy' },
    ]
    const menu = Menu.buildFromTemplate(
      states.map((s) => ({
        label: s.label,
        type: 'radio' as const,
        checked: currentState === s.id,
        click: () => {
          // 记录勾选状态，并把新状态通知渲染进程切换动画
          currentState = s.id
          win?.webContents.send('pet:set-state', s.id)
        },
      }))
    )
    menu.popup({ window: win })
  })
}

// Electron 就绪后建窗并注册 IPC
app.whenReady().then(() => {
  registerIpc()
  createWindow()
})

// 桌宠应用没有"所有窗口关闭后留驻"的需求，直接退出
app.on('window-all-closed', () => {
  app.quit()
})
