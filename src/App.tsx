// 【文件说明】桌宠组件：三状态（idle/blink/happy）8fps 逐帧动画播放器 + 鼠标拖拽移动窗口（M1 工单核心）。
// M3 桌宠交互层接线：
//   1. 单击（位移 < 5px）→ 显示快捷菜单气泡（M4 工单 A4 改造；原来是直接 openPanel）
//   2. 拖拽（位移 ≥ 5px）→ IPC 把增量发给主进程移动窗口
//   3. M3 对话链路：本地扩展 'thinking' 状态用于对话时切思考动画
//   4. 主进程通知桌宠"被隐藏/显示"：隐藏时不必要更新 DOM（已经 hide 掉）
//
// 快捷菜单 A4：
//   - 单击 → 显示气泡菜单（在我对话 / 主面板 / 隐藏桌宠 三项）
//   - 点击其他区域 → 菜单消失
//   - 「跟我对话」→ petApi.quickActionChat() → 主进程打开 panel + 切对话 Tab
//   - 「主面板」→ petApi.quickActionPanel() → 主进程打开 panel（停留当前 Tab）
//   - 「隐藏桌宠」→ petApi.quickActionHide() → 主进程 hide pet 窗，留下托盘
import { useCallback, useEffect, useRef, useState } from 'react'

// 三状态 + 思考（本地扩展，与 electron/preload.ts 的 PetState 不直接共享，避免触碰已有文件）
type PetState = 'idle' | 'blink' | 'happy' | 'thinking'

// 动画帧率：PRD §8.4 统一 8fps，即每帧 125ms
const FRAME_INTERVAL_MS = 125

// sprite 显示尺寸：32×32 源图放大 4 倍 = 128×128（PRD §8.4 新画布规范，旧 48×48/192 作废）
const PET_SIZE = 128

// 单击 vs 拖拽阈值：像素位移平方大于 5×5=25 即视为拖拽，避免拖拽误触面板
const CLICK_VS_DRAG_THRESHOLD_SQ = 25

// 默认演示人格：INTJ（猫头鹰，resources/sprites/intj/，由 scripts/make_characters.py 生成）。
const FRAMES: Record<PetState, string[]> = {
  idle: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  blink: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  happy: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  thinking: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
}

/** 快捷菜单是否打开（本地 UI 状态） */
type QuickMenuState = 'closed' | 'open'

/**
 * 桌宠根组件。
 */
export default function App(): JSX.Element {
  // 当前动画状态与当前帧序号
  const [state, setState] = useState<PetState>('idle')
  const [frame, setFrame] = useState(0)
  // 快捷菜单状态（M4 工单 A4）：open / closed
  const [menu, setMenu] = useState<QuickMenuState>('closed')

  // 鼠标按下时的状态：起始位置、上一帧位置、是否已超过拖拽阈值、按下时间戳
  const pressRef = useRef<{
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
    downAt: number
  } | null>(null)

  // 8fps 逐帧播放
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES[state].length)
    }, FRAME_INTERVAL_MS)
    setFrame(0)
    return () => clearInterval(timer)
  }, [state])

  // 订阅主进程右键菜单发来的状态切换
  useEffect(() => {
    window.petApi.onSetState((next) => setState(next))
  }, [])

  // 状态变化回告主进程
  useEffect(() => {
    if (state !== 'thinking') {
      window.petApi.notifyState(state)
    }
  }, [state])

  // 键盘调试
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === '1') setState('idle')
      else if (e.key === '2') setState('blink')
      else if (e.key === '3') setState('happy')
      else if (e.key === '4') setState('thinking')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // M3 对话链路接线：暴露 window.petState 让聊天 UI 在调 /api/chat 时切思考动画
  useEffect(() => {
    ;(window as unknown as { petState: (s: PetState) => void }).petState = (s: PetState) => setState(s)
    return () => {
      delete (window as unknown as { petState?: unknown }).petState
    }
  }, [])

  // 订阅主进程发来的"桌宠被隐藏/显示"事件
  useEffect(() => {
    window.petApi.onPetHidden((_hidden) => {
      /* 当前无需操作 */
    })
  }, [])

  /**
   * 鼠标按下：进入"待判定"状态，记录起始屏幕坐标。
   */
  const onMouseDown = useCallback((e: React.MouseEvent): void => {
    pressRef.current = {
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      moved: false,
      downAt: Date.now(),
    }
  }, [])

  // 鼠标移动 + 松手
  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      const press = pressRef.current
      if (!press) return
      const dx = e.screenX - press.lastX
      const dy = e.screenY - press.lastY
      const totalDx = e.screenX - press.startX
      const totalDy = e.screenY - press.startY
      if (!press.moved && totalDx * totalDx + totalDy * totalDy > CLICK_VS_DRAG_THRESHOLD_SQ) {
        press.moved = true
      }
      press.lastX = e.screenX
      press.lastY = e.screenY
      if (press.moved && (dx !== 0 || dy !== 0)) {
        window.petApi.drag(dx, dy)
      }
    }
    const onMouseUp = (_e: MouseEvent): void => {
      const press = pressRef.current
      pressRef.current = null
      if (!press) return
      if (!press.moved) {
        // 单击 → 切快捷菜单状态（与 M3 旧行为"openPanel"不同：A4 改为弹气泡菜单）
        setMenu((prev) => (prev === 'closed' ? 'open' : 'closed'))
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  /**
   * 快捷菜单"其他区域点击关闭"：监听 mousedown，若点击不在菜单 DOM 内则关闭。
   * 用 capture 阶段确保早于菜单自身的点击事件判定。
   */
  useEffect(() => {
    if (menu === 'closed') return
    const onDocMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // 在 pet 容器 / 菜单 DOM 内则不关闭（菜单自身的按钮点击会在 onClick 里主动关闭）
      if (target.closest('.pet-quick-menu') || target.closest('.pet-sprite')) {
        return
      }
      setMenu('closed')
    }
    window.addEventListener('mousedown', onDocMouseDown, true)
    return () => window.removeEventListener('mousedown', onDocMouseDown, true)
  }, [menu])

  /** 右键：阻止系统默认菜单，改请主进程弹出三状态切换菜单 */
  const onContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    window.petApi.showMenu()
  }, [])

  /** 「跟我对话」：通知主进程打开 panel + 切到对话 Tab */
  const onQuickChat = useCallback((): void => {
    setMenu('closed')
    window.petApi.quickActionChat()
  }, [])

  /** 「主面板」：仅打开主面板，停留当前 Tab */
  const onQuickPanel = useCallback((): void => {
    setMenu('closed')
    window.petApi.quickActionPanel()
  }, [])

  /** 「隐藏桌宠」：通知主进程隐藏 pet 窗，留下托盘 */
  const onQuickHide = useCallback((): void => {
    setMenu('closed')
    window.petApi.quickActionHide()
  }, [])

  // 当前应显示的帧图片路径
  const src = FRAMES[state][frame]

  return (
    <div
      className="pet-root"
      style={{ width: PET_SIZE, height: PET_SIZE, position: 'relative' }}
    >
      <div
        className="pet-sprite"
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        style={{ width: PET_SIZE, height: PET_SIZE, cursor: 'grab' }}
      >
        <img
          src={src}
          width={PET_SIZE}
          height={PET_SIZE}
          draggable={false}
          alt="Petibi 桌宠"
          style={{
            imageRendering: 'pixelated',
            display: 'block',
          }}
        />
      </div>

      {menu === 'open' && (
        <div className="pet-quick-menu" role="menu" aria-label="桌宠快捷菜单">
          <button
            type="button"
            className="pet-quick-item"
            onClick={onQuickChat}
            role="menuitem"
          >
            💬 跟我对话
          </button>
          <button
            type="button"
            className="pet-quick-item"
            onClick={onQuickPanel}
            role="menuitem"
          >
            🗂 主面板
          </button>
          <button
            type="button"
            className="pet-quick-item"
            onClick={onQuickHide}
            role="menuitem"
          >
            🙈 隐藏桌宠
          </button>
        </div>
      )}
    </div>
  )
}