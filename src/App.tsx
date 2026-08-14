// 【文件说明】桌宠组件：四状态（idle/blink/happy/thinking）4fps 逐帧动画播放器 + 鼠标拖拽移动窗口。
// T4 升级：sprite 由 32×32 升至 64×64（像素风不是低像素风），源图 ×2 放大到 128×128，窗口尺寸不变。
// T5 动画修复：idle 两帧"头部零差异 + 躯干 1px 下移"（Shimeji 规范，呼吸而非抽搐）；
//   帧率由 8fps 改为 4fps（每帧 250ms，参考 Shimeji 默认）。
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
//
// 收尾修复（M4 收尾工单）：
//   - 双击桌宠 → 直接打开主面板（不再走快捷菜单"主面板"选项）；
//   - 单击与双击通过 250ms 阈值区分：第一次 mousedown 记 timestamp，250ms 内
//     出现第二次 mousedown 视为双击（派发 openPanel），否则 250ms 到点派发
//     「打开快捷菜单」。状态机提取为纯函数 feedClick / isWithinDoubleClickThreshold
//     单独 vitest 覆盖（src/__tests__/decideClickSequence.test.ts）。
//   - 与 A4 设计兼容：双击的"打开主面板"行为覆盖单击的"打开快捷菜单"，
//     不会出现"双击后菜单闪一下再关"的观感问题——状态机在第二次 click 时
//     直接 clearTimer 阻止 menu 派发。
//
// M4 重测人格：sprite 路径从硬编码 'intj' 改为动态读 profile.mbti。
//   - 启动期调 petApi.getCurrentMbti()（来自主进程读 profile.json）拿到当前人格；
//   - 订阅 petApi.onSpriteChange —— 主进程在用户重测完成后广播此事件，
//     桌宠无需重启应用即可切换到新人格 sprite。
//   - 16 型白名单校验在 src/pet-sprite.ts 的 sanitizeMbti() 里统一处理（防路径穿越）。
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildSpritePaths,
  sanitizeMbti,
  spritePath,
  type PetState,
} from './pet-sprite'
import {
  DOUBLE_CLICK_THRESHOLD_MS,
  feedClick,
  type ClickState,
} from './decideClickSequence'

// 动画帧率：T5 修复 4fps（每帧 250ms），原 8fps/125ms 在 128px 下显得抽搐而非呼吸
const FRAME_INTERVAL_MS = 250

// sprite 显示尺寸：T4 升级 64×64 源图 ×2 放大到 128×128（窗口尺寸沿用 128，electron 侧不动）
const PET_SIZE = 128

// 单击 vs 拖拽阈值：像素位移平方大于 5×5=25 即视为拖拽，避免拖拽误触面板
const CLICK_VS_DRAG_THRESHOLD_SQ = 25

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
  // M4 重测人格：当前人格 mbti（决定 sprite 路径前缀）。
  // 启动时先取 'intj' 兜底，主进程 ready 后用真值覆盖；重测后由 onSpriteChange 推送更新。
  const [mbti, setMbti] = useState<string>('intj')

  // 鼠标按下时的状态：起始位置、上一帧位置、是否已超过拖拽阈值、按下时间戳
  const pressRef = useRef<{
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
    downAt: number
  } | null>(null)

  // 收尾修复：单击/双击状态机（M4 收尾工单）。
  //   - clickState: 'idle' 无 pending / 'pending' 250ms 等待中；
  //   - pendingTimerRef: 250ms 计时器引用，状态机派发 action 后必须 clearTimeout。
  // 不与 pressRef 合并是因为 pressRef 是拖拽/松手用（短生命周期），而 clickState
  // 跨多次 mouseup 留存（最多 250ms），生命周期不同；分开管理更清晰。
  const [clickState, setClickState] = useState<ClickState>('idle')
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 启动期读当前人格 mbti（来自主进程读 profile.json）
  useEffect(() => {
    const api = window.petApi
    if (!api || typeof api.getCurrentMbti !== 'function') {
      // 渲染端在非 pet 角色窗口下也能 mount（理论上不会），但兜底留 'intj'
      return
    }
    void api
      .getCurrentMbti()
      .then((value) => {
        if (typeof value === 'string' && value.length > 0) {
          setMbti(sanitizeMbti(value))
        }
      })
      .catch((err: unknown) => {
        console.warn('[pet] getCurrentMbti 失败，使用 intj 兜底：', err)
      })
  }, [])

  // 订阅主进程广播的 sprite 切换事件（用户完成重测后触发）
  useEffect(() => {
    const api = window.petApi
    if (!api || typeof api.onSpriteChange !== 'function') return
    api.onSpriteChange((next: string) => {
      if (typeof next !== 'string') return
      // 主进程已校验过 16 型白名单，这里走 sanitizeMbti 再校验一次（防御纵深）
      setMbti(sanitizeMbti(next))
      // 重测后回到 idle 帧，避免仍在旧 thinking 状态被新 sprite 顶替
      setState('idle')
      setFrame(0)
    })
  }, [])

  // 8fps 逐帧播放
  useEffect(() => {
    const timer = setInterval(() => {
      const frames = buildSpritePaths(mbti)
      setFrame((prev) => (prev + 1) % frames[state].length)
    }, FRAME_INTERVAL_MS)
    setFrame(0)
    return () => clearInterval(timer)
  }, [state, mbti])

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
      if (press.moved) return
      // 收尾修复：单击 vs 双击用 250ms 阈值区分（见 src/__tests__/decideClickSequence）。
      //   - 单击（无后续点击）→ 250ms 延时后派发「打开快捷菜单」；
      //   - 双击（250ms 内再次点击）→ 立即派发「打开主面板」；
      // 走状态机纯函数 feedClick 决定下一步；状态机返回的 clearTimer 标记
      // 在双击分支会清掉 pending timer，避免"双击后又弹菜单"的重复派发。
      const now = Date.now()
      const decision = feedClick(clickState, { type: 'click', timestamp: now })
      if (decision.clearTimer && pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      setClickState(decision.next)
      if (decision.action === 'menu') {
        // 单击延时到点：弹快捷菜单
        setMenu((prev) => (prev === 'closed' ? 'open' : 'closed'))
      } else if (decision.action === 'panel') {
        // 双击：直接打开主面板（不弹菜单，避免双击后闪一下）
        setMenu('closed')
        window.petApi.quickActionPanel()
      } else {
        // 进入 pending：起 250ms 定时器，到点派发 menu
        pendingTimerRef.current = setTimeout(() => {
          pendingTimerRef.current = null
          // 防御性：再次喂 fire-pending 给状态机（idle 状态下 no-op）
          const fireDecision = feedClick('pending', { type: 'fire-pending' })
          setClickState(fireDecision.next)
          if (fireDecision.action === 'menu') {
            setMenu((prev) => (prev === 'closed' ? 'open' : 'closed'))
          }
        }, DOUBLE_CLICK_THRESHOLD_MS)
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      // 清理：组件卸载时清掉 pending timer，避免内存泄漏
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
    }
  }, [clickState])

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

  /** 右键：阻止系统默认菜单，改请主进程弹出精简后的三项菜单（主面板 / 隐藏桌宠 / 退出） */
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

  // 当前应显示的帧图片路径（M4 动态：根据当前 mbti 拼 sprite 路径）
  const src = spritePath(mbti, state, frame)

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
            <PetChatIcon />
            <span>跟我对话</span>
          </button>
          <button
            type="button"
            className="pet-quick-item"
            onClick={onQuickPanel}
            role="menuitem"
          >
            <PetPanelIcon />
            <span>主面板</span>
          </button>
          <button
            type="button"
            className="pet-quick-item"
            onClick={onQuickHide}
            role="menuitem"
          >
            <PetHideIcon />
            <span>隐藏桌宠</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ===== 像素风快捷菜单图标（DESIGN.md §3 禁止 emoji 当功能图标）=====
/** 对话气泡 icon：8×8 像素方块 + 三角尾巴 */
function PetChatIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="1" y="1" width="10" height="1" fill="#2B2320" />
      <rect x="1" y="2" width="10" height="7" fill="#FEF9EF" />
      <rect x="1" y="2" width="1" height="7" fill="#2B2320" />
      <rect x="10" y="2" width="1" height="7" fill="#2B2320" />
      <rect x="1" y="9" width="10" height="1" fill="#2B2320" />
      <rect x="3" y="10" width="2" height="2" fill="#FEF9EF" />
      <rect x="3" y="10" width="1" height="2" fill="#2B2320" />
      <rect x="4" y="10" width="1" height="2" fill="#2B2320" />
      {/* 三点对话内容 */}
      <rect x="3" y="5" width="1" height="1" fill="#785D87" />
      <rect x="5" y="5" width="1" height="1" fill="#785D87" />
      <rect x="7" y="5" width="1" height="1" fill="#785D87" />
    </svg>
  )
}

/** 主面板 icon：2×2 网格方块 */
function PetPanelIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="1" y="1" width="4" height="4" fill="#2B2320" />
      <rect x="2" y="2" width="2" height="2" fill="#FEF9EF" />
      <rect x="7" y="1" width="4" height="4" fill="#2B2320" />
      <rect x="8" y="2" width="2" height="2" fill="#FEF9EF" />
      <rect x="1" y="7" width="4" height="4" fill="#2B2320" />
      <rect x="2" y="8" width="2" height="2" fill="#FEF9EF" />
      <rect x="7" y="7" width="4" height="4" fill="#2B2320" />
      <rect x="8" y="8" width="2" height="2" fill="#FEF9EF" />
    </svg>
  )
}

/** 隐藏桌宠 icon：带斜杠的眼睛 */
function PetHideIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="1" y="5" width="10" height="2" fill="#2B2320" />
      <rect x="2" y="6" width="8" height="1" fill="#FEF9EF" />
      {/* 斜杠 */}
      <rect x="3" y="3" width="1" height="1" fill="#2B2320" />
      <rect x="4" y="4" width="1" height="1" fill="#2B2320" />
      <rect x="5" y="5" width="1" height="1" fill="#2B2320" />
      <rect x="6" y="6" width="1" height="1" fill="#2B2320" />
      <rect x="7" y="7" width="1" height="1" fill="#2B2320" />
      <rect x="8" y="8" width="1" height="1" fill="#2B2320" />
    </svg>
  )
}