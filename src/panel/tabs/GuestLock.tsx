// 【文件说明】访客模式下的"登录后解锁"遮罩（M4 工单 A3）：
//   - 用于锁定对话 / 测试入口：guest 模式（未登录）点击这些功能时显示全屏遮罩 + "登录后解锁"按钮；
//   - 点击"去登录"会触发 onLogin 回调，由父组件调主进程打开 setup 窗；
//   - 不参与访客可浏览的百科 / 社区 Tab（这两个 Tab 在 guest 态直接展示内容）。
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
 * 访客锁：覆盖在受限 Tab 之上，背景半透明黑，提示登录。
 * 设计成"提示而非拦截"——用户始终能切换 Tab，但看不到内容，体验更顺滑。
 */
export function GuestLock({ featureName, description, onLogin }: GuestLockProps): ReactNode {
  return (
    <div className="guest-lock" role="dialog" aria-label={`${featureName}登录后解锁`}>
      <div className="guest-lock-card">
        <div className="guest-lock-emoji" aria-hidden="true">🔒</div>
        <div className="guest-lock-title">{featureName}登录后解锁</div>
        <div className="guest-lock-desc">{description}</div>
        <button
          type="button"
          className="btn guest-lock-btn"
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