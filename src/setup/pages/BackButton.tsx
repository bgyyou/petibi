// 【文件说明】setup 流程统一的「← 返回」按钮（M4 工单 + 收尾修复）：
//   - 像素风纸白底 + 3px 墨边框 + 硬阴影（DESIGN.md §3 / §5）；
//   - 左箭头 icon 用 SVG 像素画（shape-rendering: crispEdges），禁止 emoji（DESIGN.md §3）；
//   - 接收 onClick 与 label（"返回昵称"/"返回登录"等），由调用方控制；
//   - disabled=true 时按钮置灰不响应（retest 模式下隐藏：调用方直接不渲染）。
//   - 风格对齐 .setup-back CSS class。
//
// 收尾修复：data-testid 增加当前步骤标识，便于 owner / 自动化脚本确认"页面上
// 真实存在一个返回按钮"（之前 data-role 不区分页，4 页都返回同一值）。
// data-back-target 与 label 文本一致，方便 E2E 断言"这一页的回退目标文字是 X"。
import type { MouseEventHandler } from 'react'

interface BackButtonProps {
  /** 点击行为（通常 dispatch 对应 BACK_* action） */
  onClick: MouseEventHandler<HTMLButtonElement>
  /** 按钮文字（"返回昵称" / "返回登录" / "重选人格" 等） */
  label: string
  /** 是否置灰不响应；retest 模式下 PickTypePage 直接不渲染本组件 */
  disabled?: boolean
  /** 当前页 step 名（nickname / pick / test / result），用于 data-testid 区分 */
  step?: string
}

/**
 * 像素风 ← 返回按钮。setup 流程每步（昵称/选人格/测试/结果）的统一返回入口。
 * 设计上走 onClick 回调而非内联 dispatch：让单元测试与重定向更灵活。
 */
export function BackButton({
  onClick,
  label,
  disabled = false,
  step,
}: BackButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="setup-back"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-role="setup-back-btn"
      data-testid={step ? `setup-back-${step}` : 'setup-back-btn'}
      data-back-target={label}
    >
      <span className="setup-back-icon" aria-hidden="true">
        <BackArrowIcon />
      </span>
      <span className="setup-back-label">{label}</span>
    </button>
  )
}

/**
 * 左箭头像素 icon：12×12 viewBox，三排像素硬边画一个左箭头。
 * 严格走 SVG rect + crispEdges，与 src/App.tsx 里的 PetChatIcon 等同源风格。
 */
function BackArrowIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" shapeRendering="crispEdges" aria-hidden="true">
      {/* 左箭头横杆：3 行像素（中间宽，上下窄） */}
      <rect x="3" y="2" width="1" height="8" fill="#2B2320" />
      <rect x="4" y="3" width="1" height="6" fill="#2B2320" />
      <rect x="5" y="4" width="1" height="4" fill="#2B2320" />
      <rect x="6" y="5" width="1" height="2" fill="#2B2320" />
      {/* 左箭头头部三角：5 行像素递减 */}
      <rect x="4" y="5" width="1" height="2" fill="#2B2320" />
      <rect x="3" y="4" width="1" height="1" fill="#2B2320" />
      <rect x="3" y="7" width="1" height="1" fill="#2B2320" />
      <rect x="2" y="5" width="1" height="2" fill="#2B2320" />
    </svg>
  )
}