// 【文件说明】16 人格选择页（PRD §3.2 步骤 2/3）：
//   - 默认展示 16 张卡片；
//   - 选中一张 → 直接进入结果页（直接选用的人格已确定）；
//   - 不确定 → 进入测试页（计分后给出结果）。
//
// M4 setup 返回导航：左上角加「← 返回」按钮，回昵称页。
//   - 派发 BACK_TO_NICKNAME 只切 step 不清 nickname/email/token（reducer 设计如此）；
//   - **retest 模式直接不渲染返回按钮**：retest 入口是 PickTypePage 本身，
//     用户已登录、已有昵称，再点返回会退回 LoginPage 造成困惑——所以隐藏。
import { useState } from 'react'
import { useSetup } from '../state/setupStore'
import { PERSONAS, FAMILY_COLORS, type PersonaMeta } from '../persona-meta'
import { BackButton } from './BackButton'

export function PickTypePage(): JSX.Element {
  const { state, dispatch } = useSetup()
  const [selected, setSelected] = useState<string | null>(null)
  // retest 模式下入口就是 PickTypePage，按钮隐藏（避免误退回登录页）
  const isRetest = state.mode === 'retest'

  // 直接选用人格 → 派发 PICK_TYPE（reducer 跳到 result）
  function handleConfirm(): void {
    if (!selected) return
    dispatch({ type: 'PICK_TYPE', mbti: selected })
  }

  // 进入测试 → 清空答案并切到 test
  function handleStartTest(): void {
    dispatch({ type: 'GO_TEST' })
  }

  // 返回昵称页（retest 模式下按钮不渲染，此 handler 不会被触发）
  function handleBack(): void {
    dispatch({ type: 'BACK_TO_NICKNAME' })
  }

  return (
    <div className="setup-shell">
      {!isRetest && <BackButton onClick={handleBack} label="返回昵称" step="pick" />}
      <header className="setup-header">
        <h1 className="setup-title">你是哪种人格？</h1>
        <p className="setup-subtitle">已知 → 直接选；不确定 → 进入 40 题测试</p>
      </header>
      <div className="setup-body">
        <div className="persona-grid">
          {PERSONAS.map((p) => (
            <PersonaCard
              key={p.type}
              meta={p}
              isSelected={selected === p.type}
              onClick={() => setSelected(p.type)}
            />
          ))}
        </div>
      </div>
      <footer className="setup-footer">
        <button type="button" className="btn btn-ghost" onClick={handleStartTest}>
          不确定 → 去测一下
        </button>
        <button type="button" className="btn" onClick={handleConfirm} disabled={!selected}>
          {selected ? `确定 ${selected}` : '请选择一张卡片'}
        </button>
      </footer>
    </div>
  )
}

interface CardProps {
  meta: PersonaMeta
  isSelected: boolean
  onClick: () => void
}

function PersonaCard({ meta, isSelected, onClick }: CardProps): JSX.Element {
  const colors = FAMILY_COLORS[meta.family]
  return (
    <button
      type="button"
      className={`persona-card ${isSelected ? 'is-selected' : ''}`}
      style={{
        background: colors.bg,
        color: colors.fg,
        border: `3px solid ${isSelected ? 'var(--ink)' : colors.border}`,
      }}
      onClick={onClick}
      title={meta.tagline}
    >
      <span className="persona-card-type">{meta.type}</span>
      <span className="persona-card-animal">{meta.animal}</span>
    </button>
  )
}