// 【文件说明】桌宠组件：三状态（idle/blink/happy）8fps 逐帧动画播放器 + 鼠标拖拽移动窗口（M1 工单核心）。
// M3 桌宠交互层接线：
//   1. 单击（位移 < 5px）→ 通过 IPC 打开主面板（petApi.openPanel）
//   2. 拖拽（位移 ≥ 5px）→ IPC 把增量发给主进程移动窗口
//   3. M3 对话链路：本地扩展 'thinking' 状态用于对话时切思考动画，专用帧待后续工单补齐
//   4. 主进程通知桌宠"被隐藏/显示"：隐藏时不必要更新 DOM（已经 hide 掉），订阅仅用于日后扩展
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
// 16 人格 sprite 已就位但每只目前只有 idle 2 帧（M1 工单范围），
// blink / happy / thinking 状态暂复用 idle 帧占位，待后续动画工单补齐专用帧。
// resources/ 已配置为渲染进程 publicDir，打包时原样拷贝，故用相对路径引用即可
const FRAMES: Record<PetState, string[]> = {
  idle: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  blink: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  happy: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  thinking: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
}

/**
 * 桌宠根组件。
 * 职责一：按 8fps 循环播放当前状态的帧序列；
 * 职责二：响应鼠标拖拽（≥5px），通过 IPC 让主进程移动窗口（透明窗不能用 -webkit-app-region:drag）；
 * 职责三：响应鼠标单击（<5px），通过 IPC 打开主面板；
 * 职责四：右键菜单 / 数字键 1、2、3 切换动画状态（调试用）。
 */
export default function App(): JSX.Element {
  // 当前动画状态与当前帧序号
  const [state, setState] = useState<PetState>('idle')
  const [frame, setFrame] = useState(0)

  // 鼠标按下时的状态：起始位置、上一帧位置、是否已超过拖拽阈值、按下时间戳
  // 用 ref 避免每次移动都触发重渲染
  const pressRef = useRef<{
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
    downAt: number
  } | null>(null)

  // 8fps 逐帧播放：每 125ms 把帧序号 +1，对当前状态帧数取模实现循环
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES[state].length)
    }, FRAME_INTERVAL_MS)
    // 状态切换时 effect 重建，先回到第 0 帧，避免帧序号越界旧状态
    setFrame(0)
    return () => clearInterval(timer)
  }, [state])

  // 订阅主进程右键菜单发来的状态切换（组件卸载时无需清理：桌宠单窗口生命周期即应用生命周期）
  useEffect(() => {
    window.petApi.onSetState((next) => setState(next))
  }, [])

  // 状态变化（含键盘切换）回告主进程，保证下次右键菜单的单选勾选显示正确
  // 注：本地扩展了 'thinking' 但主进程 preload 的 PetState 暂未包含；只回告主进程已知的三态，
  // 'thinking' 是纯本地 UI 态，不进右键菜单单选。
  useEffect(() => {
    if (state !== 'thinking') {
      window.petApi.notifyState(state)
    }
  }, [state])

  // 键盘调试：按 1 / 2 / 3 / 4 直接切换 idle / blink / happy / thinking
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

  // M3 对话链路接线：暴露 window.petState 让未来聊天 UI 在调 /api/chat 时切思考动画
  // 调用方：开始 fetch → petState('thinking')；fetch 结束（done/error）→ petState('idle')
  // 当前 PR 未引入实际聊天 UI，chat 落地时由调用方按此约定接入；hook 现在只注册钩子
  useEffect(() => {
    ;(window as unknown as { petState: (s: PetState) => void }).petState = (s: PetState) => setState(s)
    return () => {
      delete (window as unknown as { petState?: unknown }).petState
    }
  }, [])

  // 订阅主进程发来的"桌宠被隐藏/显示"事件（占位：M3 当前仅做通知，
  // 桌宠隐藏时 DOM 已被主进程 hide，无需 React 额外处理；订阅仅为后续扩展预留）
  useEffect(() => {
    window.petApi.onPetHidden((_hidden) => {
      /* 当前无需操作；保留订阅便于未来加 UI 状态 */
    })
  }, [])

  /**
   * 鼠标按下：进入"待判定"状态，记录起始屏幕坐标（screenX/screenY 与主进程窗口坐标同一坐标系）。
   * 此时不立即判定单击还是拖拽——鼠标可能还要移动。
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

  // 鼠标移动 + 松手：监听挂在 window 上，保证鼠标快速移出 128×128 窗口时事件仍能收到
  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      const press = pressRef.current
      if (!press) return
      const dx = e.screenX - press.lastX
      const dy = e.screenY - press.lastY
      // 判定是否拖拽：与按下点的距离平方 > 25（即半径 5px）即视为拖拽
      const totalDx = e.screenX - press.startX
      const totalDy = e.screenY - press.startY
      if (!press.moved && totalDx * totalDx + totalDy * totalDy > CLICK_VS_DRAG_THRESHOLD_SQ) {
        press.moved = true
      }
      press.lastX = e.screenX
      press.lastY = e.screenY
      // 仅在已判定为拖拽时才发位移增量；避免微小抖动就被主进程叠加位移
      if (press.moved && (dx !== 0 || dy !== 0)) {
        window.petApi.drag(dx, dy)
      }
    }
    const onMouseUp = (_e: MouseEvent): void => {
      const press = pressRef.current
      pressRef.current = null
      if (!press) return
      // 未超过阈值且按下到松手时长合理（防长按误判）→ 单击 → 打开主面板
      // 不限时长上限：用户长按拖拽会被 markedMoved=true 自动屏蔽单击
      if (!press.moved) {
        window.petApi.openPanel()
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  /** 右键：阻止系统默认菜单，改请主进程弹出三状态切换菜单 */
  const onContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    window.petApi.showMenu()
  }, [])

  // 当前应显示的帧图片路径
  const src = FRAMES[state][frame]

  return (
    <div
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
          // 像素风放大必须关闭平滑插值，保持锐利硬边（工单技术决策）
          imageRendering: 'pixelated',
          display: 'block',
        }}
      />
    </div>
  )
}