// 【文件说明】桌宠组件：三状态（idle/blink/happy）8fps 逐帧动画播放器 + 鼠标拖拽移动窗口（M1 工单核心）
import { useCallback, useEffect, useRef, useState } from 'react'

// 三状态动画的联合类型（与 electron/preload.ts 约定一致）
type PetState = 'idle' | 'blink' | 'happy'

// 动画帧率：PRD §8.4 统一 8fps，即每帧 125ms
const FRAME_INTERVAL_MS = 125

// sprite 显示尺寸：32×32 源图放大 4 倍 = 128×128（PRD §8.4 新画布规范，旧 48×48/192 作废）
const PET_SIZE = 128

// 默认演示人格：INTJ（猫头鹰，resources/sprites/intj/，由 scripts/make_characters.py 生成）。
// 16 人格 sprite 已就位但每只目前只有 idle 2 帧（M1 工单范围），
// blink / happy 状态暂复用 idle 帧占位，待后续动画工单补齐专用帧。
// resources/ 已配置为渲染进程 publicDir，打包时原样拷贝，故用相对路径引用即可
const FRAMES: Record<PetState, string[]> = {
  idle: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  blink: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
  happy: ['sprites/intj/idle_0.png', 'sprites/intj/idle_1.png'],
}

/**
 * 桌宠根组件。
 * 职责一：按 8fps 循环播放当前状态的帧序列；
 * 职责二：响应鼠标拖拽，通过 IPC 让主进程移动窗口（透明窗不能用 -webkit-app-region:drag）；
 * 职责三：右键菜单 / 数字键 1、2、3 切换动画状态（调试用）。
 */
export default function App(): JSX.Element {
  // 当前动画状态与当前帧序号
  const [state, setState] = useState<PetState>('idle')
  const [frame, setFrame] = useState(0)

  // 拖拽进行中的标记与"上一次鼠标屏幕坐标"（用 ref 避免每次移动都触发重渲染）
  const draggingRef = useRef(false)
  const lastPosRef = useRef({ x: 0, y: 0 })

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
  useEffect(() => {
    window.petApi.notifyState(state)
  }, [state])

  // 键盘调试：按 1 / 2 / 3 直接切换 idle / blink / happy
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === '1') setState('idle')
      else if (e.key === '2') setState('blink')
      else if (e.key === '3') setState('happy')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** 鼠标按下：进入拖拽状态，记录起始屏幕坐标（screenX/screenY 与主进程窗口坐标同一坐标系） */
  const onMouseDown = useCallback((e: React.MouseEvent): void => {
    draggingRef.current = true
    lastPosRef.current = { x: e.screenX, y: e.screenY }
  }, [])

  // 拖拽移动与松手：监听挂在 window 上，保证鼠标快速移出 128×128 窗口时事件仍能收到
  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      // 计算相对上一帧事件的位移增量，发给主进程叠加到窗口位置上
      const dx = e.screenX - lastPosRef.current.x
      const dy = e.screenY - lastPosRef.current.y
      lastPosRef.current = { x: e.screenX, y: e.screenY }
      if (dx !== 0 || dy !== 0) {
        window.petApi.drag(dx, dy)
      }
    }
    const onMouseUp = (): void => {
      // 松手即停：窗口停在当前位置
      draggingRef.current = false
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
