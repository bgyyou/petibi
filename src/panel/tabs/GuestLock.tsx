// 【文件说明】访客模式下的"登录后解锁"遮罩（M4 工单 A3 / T3 工单）：
//   - 用于锁定对话 / 我的 Tab：guest 模式点击这些功能时显示全屏遮罩 + "去登录"按钮；
//   - 点击"去登录"会触发 onLogin 回调，由父组件调主进程打开 setup 窗；
//   - 不参与访客可浏览的百科 / 社区 Tab（这两个 Tab 在 guest 态直接展示内容）；
//   - T3 工单第 5 条：🔒 emoji 改为像素 SVG icon（DESIGN.md §3 禁止 emoji 当功能图标）。
import type { ReactNode } from 'react'

interface GuestLockProps {
  /** 锁定区域的功能名（"对话"/"测试"等），用于描述用户当前想用的能力 */
  featureName: string
  /** 一句话说明为什么锁定（"登录后开启人格对话"等） */
  description: string
  /** 用户点"去登录"时回调：父组件调主进程打开 setup 窗 */
  onLogin: () => void
}

/**
 * 访客锁：覆盖在受限 Tab 之上，背景奶油色 + 卡片居中。
 * 设计成"提示而非拦截"——用户始终能切换 Tab，但看不到内容，体验更顺滑。
 */
export function GuestLock({ featureName, description, onLogin }: GuestLockProps): ReactNode {
  return (
    <div className="guest-lock" role="dialog" aria-label={`${featureName}登录后解锁`}>
      <div className="guest-lock-card">
        {/* 像素锁标 SVG（替代 🔒 emoji） */}
        <PixelLockIcon />
        <div className="guest-lock-title">{featureName}登录后解锁</div>
        <div className="guest-lock-desc">{description}</div>
        <button
          type="button"
          className="guest-lock-btn"
          onClick={onLogin}
          aria-label="去登录"
        >
          去登录 / 开始测试
        </button>
        <div className="guest-lock-sub">
          也可以先逛逛 <strong>百科</strong> 和 <strong>社区</strong>。
        </div>
      </div>
    </div>
  )
}

/** 像素风锁标：纯 SVG 拼一个 8×8 像素 + 锁柱 + 钥匙孔 */
function PixelLockIcon(): ReactNode {
  return (
    <svg
      className="guest-lock-icon"
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* 锁柱（顶部圆环，6×4 像素） */}
      <rect x="5" y="2" width="1" height="1" fill="#2B2320" />
      <rect x="10" y="2" width="1" height="1" fill="#2B2320" />
      <rect x="4" y="3" width="1" height="3" fill="#2B2320" />
      <rect x="11" y="3" width="1" height="3" fill="#2B2320" />
      <rect x="5" y="6" width="6" height="1" fill="#2B2320" />
      {/* 锁体（8×7 矩形） */}
      <rect x="3" y="7" width="10" height="1" fill="#2B2320" />
      <rect x="3" y="8" width="10" height="6" fill="#785D87" />
      <rect x="3" y="8" width="10" height="1" fill="#2B2320" />
      <rect x="3" y="13" width="10" height="1" fill="#2B2320" />
      {/* 锁体边框 */}
      <rect x="3" y="7" width="1" height="7" fill="#2B2320" />
      <rect x="12" y="7" width="1" height="7" fill="#2B2320" />
      {/* 钥匙孔（白色圆点 + 下方短线） */}
      <rect x="7" y="9" width="2" height="2" fill="#FEF9EF" />
      <rect x="7" y="11" width="2" height="2" fill="#FEF9EF" />
    </svg>
  )
}