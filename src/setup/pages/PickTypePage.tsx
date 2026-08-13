// 【文件说明】16 人格选择页（PRD §3.2 步骤 2/3）：
//   - 默认展示 16 张卡片；
//   - 选中一张 → 直接进入结果页（直接选用的人格已确定）；
//   - 不确定 → 进入测试页（计分后给出结果）。
import { useState } from 'react'
import { useSetup } from '../state/setupStore'
import { PERSONAS, FAMILY_COLORS, type PersonaMeta } from '../persona-meta'

export function PickTypePage(): JSX.Element {
  const { dispatch } = useSetup()
  const [selected, setSelected] = useState<string | null>(null)

  // 直接选用人格 → 派发 PICK_TYPE（reducer 跳到 result）
  function handleConfirm(): void {
    if (!selected) return
    dispatch({ type: 'PICK_TYPE', mbti: selected })
  }

  // 进入测试 → 清空答案并切到 test
  function handleStartTest(): void {
    dispatch({ type: 'GO_TEST' })
  }

  return (
    <div className="setup-shell">
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
        border: `1px solid ${isSelected ? '#2a2a28' : colors.border}`,
      }}
      onClick={onClick}
      title={meta.tagline}
    >
      <span className="persona-card-type">{meta.type}</span>
      <span className="persona-card-animal">{meta.animal}</span>
    </button>
  )
}