// 【文件说明】Petibi 自绘窗口标题栏（DESIGN.md §6 + 收尾修复）：
//   setup / panel 两个窗口改为无边框（frame:false）后，由本组件接管窗口标题栏。
//   - 高度 28px、奶油底（#FEF9EF），左侧 Petibi 像素 logo + 标题文字
//   - 右侧自绘像素最小化 / 关闭按钮（16×16 icon）
//   - 标题栏可拖拽（-webkit-app-region: drag），按钮不可拖拽（no-drag）
//   - 桌面小窗需要"整窗可拖动"，但按钮区要做 no-drag，否则无法点
//
// 收尾修复：
//   1. 最小化按钮点击无反应。原因排查：原实现用 `(window as unknown as { petApi?: ... }).petApi`
//      类型断言 + 多次 `if (fn?.minimizeSetup) ... else if (fn?.minimizePanel)` 链式调用；
//      在某些 Electron 版本下 `app-region: drag` 父元素会拦截子按钮的 mousedown，
//      导致 onClick 不触发。修复：
//        a) 显式 `onMouseDown={(e) => e.stopPropagation()}` 阻止父级 drag 区域吞事件；
//        b) 把"按 role 调不同 IPC"拆成两个具名函数，调用方直接传 `minimize` / `close` 回调，
//           不再依赖运行时类型断言 + 字符串匹配 document.title；
//        c) 按钮加 `data-testid` 与 `data-role` 便于 owner / E2E 验收。
//   2. 关闭按钮维持原行为（owner 已确认"关闭 = 隐藏到托盘 / setup = 退出"是合理的）。
//
// 调用方：src/setup/App.tsx 与 src/panel/App.tsx 都在最外层包一层 <TitleBar>。
// IPC：通过 window.petApi / window.panelApi 暴露的 minimize/close 通道调用主进程。

import type { MouseEvent, ReactNode } from 'react'

/** TitleBar 共享 props：标题文案 + 像素 logo 槽位（自定义节点） */
interface TitleBarProps {
  /** 窗口标题，例如 "Petibi 初始化" / "Petibi" */
  title: string
  /** 是否显示最小化按钮；桌宠/隐藏面板场景可关 */
  showMinimize?: boolean
  /** 标题文字前的小图标（像素 logo）；不传则用默认的 Petibi 像素点阵 */
  logo?: ReactNode
  /**
   * 最小化回调：调用方负责通知主进程 minimize 当前窗口。
   * 不传则按钮不响应（用于桌宠 / 隐藏面板等不需要最小化的场景）。
   */
  onMinimize?: () => void
  /**
   * 关闭回调：调用方负责通知主进程走"隐藏 / 退出"对应策略。
   * 不传则按钮不响应。
   */
  onClose?: () => void
}

/**
 * Petibi 标题栏组件。
 * 收尾修复：onMinimize / onClose 由调用方显式注入，不再依赖运行时类型断言。
 * 这样：
 *   1. 测试可在 jsdom 下直接传 mock 函数验证点击行为；
 *   2. setup / panel / pet 三窗口各自传自己专属的 IPC 通道，链路清晰；
 *   3. 移除对 document.title 的字符串比较（panel 标题碰巧是 'Petibi' 的脆弱约定）。
 */
export function TitleBar({
  title,
  showMinimize = true,
  logo,
  onMinimize,
  onClose,
}: TitleBarProps): ReactNode {
  /**
   * 阻止父级 -webkit-app-region: drag 拦截 mousedown。
   * Electron 在某些版本下，"drag 区域内子元素"的 mousedown 会被父级消费，
   * 导致 button 的 onClick 不触发；这里显式 stopPropagation 兜底。
   */
  function swallowDragArea(e: MouseEvent<HTMLButtonElement>): void {
    e.stopPropagation()
  }

  return (
    <div className="petibi-titlebar" data-role="petibi-titlebar">
      <div className="petibi-titlebar-drag">
        <div className="petibi-titlebar-logo" aria-hidden="true">
          {logo ?? <DefaultPetibiLogo />}
        </div>
        <span className="petibi-titlebar-title pixel-title">{title}</span>
      </div>
      <div className="petibi-titlebar-actions">
        {showMinimize && (
          <button
            type="button"
            className="petibi-titlebar-btn petibi-titlebar-min"
            onClick={onMinimize}
            onMouseDown={swallowDragArea}
            disabled={!onMinimize}
            aria-label="最小化窗口"
            title="最小化"
            data-testid="titlebar-minimize-btn"
            data-role="titlebar-minimize"
          >
            <MinimizeIcon />
          </button>
        )}
        <button
          type="button"
          className="petibi-titlebar-btn petibi-titlebar-close"
          onClick={onClose}
          onMouseDown={swallowDragArea}
          disabled={!onClose}
          aria-label="关闭窗口"
          title="关闭"
          data-testid="titlebar-close-btn"
          data-role="titlebar-close"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}

/**
 * Petibi 默认像素 logo（CSS 拼一个 8×8 像素方块 + 中心亮色点）。
 * 避免引入额外图片资源，与设计令牌保持一致。
 */
function DefaultPetibiLogo(): ReactNode {
  // 8x8 像素图：奶油 + 紫 + 墨色描边，象征人格 logo
  const cells = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 2, 2, 2, 2, 1, 0],
    [0, 1, 2, 3, 3, 2, 1, 0],
    [0, 1, 2, 3, 3, 2, 1, 0],
    [0, 1, 2, 2, 2, 2, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ]
  // 配色：0=墨色透明边、1=墨色描边、2=紫族色（分析家，DESIGN.md §2）、3=奶油中心
  const colorMap = ['transparent', '#2B2320', '#785D87', '#FEF9EF']
  return (
    <div className="petibi-logo-grid" aria-hidden="true">
      {cells.flatMap((row, y) =>
        row.map((v, x) => (
          <span
            key={`${x}-${y}`}
            style={{
              gridColumn: x + 1,
              gridRow: y + 1,
              background: colorMap[v] ?? 'transparent',
            }}
          />
        )),
      )}
    </div>
  )
}

/** 最小化图标：一条横线（—），用 SVG 像素画 */
function MinimizeIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" shapeRendering="crispEdges">
      <rect x="3" y="11" width="10" height="2" fill="currentColor" />
    </svg>
  )
}

/** 关闭图标：叉（×），两个像素斜条组成 */
function CloseIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" shapeRendering="crispEdges">
      <rect x="7" y="2" width="2" height="2" fill="currentColor" />
      <rect x="5" y="4" width="2" height="2" fill="currentColor" />
      <rect x="3" y="6" width="2" height="2" fill="currentColor" />
      <rect x="11" y="6" width="2" height="2" fill="currentColor" />
      <rect x="9" y="4" width="2" height="2" fill="currentColor" />
      <rect x="11" y="8" width="2" height="2" fill="currentColor" />
      <rect x="9" y="10" width="2" height="2" fill="currentColor" />
      <rect x="7" y="12" width="2" height="2" fill="currentColor" />
      <rect x="5" y="10" width="2" height="2" fill="currentColor" />
      <rect x="3" y="8" width="2" height="2" fill="currentColor" />
    </svg>
  )
}