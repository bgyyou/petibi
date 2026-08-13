// 【文件说明】占位 Tab 组件：百科 / 社区 / 我的 三个 Tab 的统一占位页。
// 显示模块名 + 一句话说明 + "即将上线"标签；
// 等后续工单实现各模块时直接替换本组件即可，不必动 App.tsx 路由。
import type { ReactNode } from 'react'

interface PlaceholderTabProps {
  /** 模块名（顶部标题） */
  title: string
  /** 一句话功能描述（占位说明） */
  description: string
}

export function PlaceholderTab({ title, description }: PlaceholderTabProps): ReactNode {
  return (
    <div className="placeholder-shell" role="region" aria-label={title}>
      <h2 className="placeholder-title">{title}</h2>
      <p className="placeholder-desc">{description}</p>
      <span className="placeholder-badge">即将上线</span>
    </div>
  )
}