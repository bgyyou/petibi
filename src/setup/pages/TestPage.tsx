// 【文件说明】测试页（PRD §3.3）：一题一屏 + 顶部进度条 + 可返回上一题。
// 选型理由：一题一屏更易集中注意力，且 40 题量在每题独立思考下完成时长仍可控（中位 ≤ 5 分钟）。
// 计分：所有题答完后调 score() 出结果，dispatch GO_RESULT 跳到结果页。
import { useMemo } from 'react'
import { useSetup } from '../state/setupStore'
import { questionBank } from '../../scoring/questions'
import { score } from '../../scoring/score'
import type { AnswerValue } from '../../scoring/types'

// 5 级量表的中文标签（5=非常同意，1=非常不同意）——与数据契约 §1 一致
const SCALE_LABELS = ['非常不同意', '不同意', '中立', '同意', '非常同意']

export function TestPage(): JSX.Element {
  const { state, dispatch } = useSetup()
  const total = questionBank.questions.length
  // 用 useMemo 把题号数组缓存住，避免每次渲染都重新算 length
  const questionList = useMemo(() => questionBank.questions, [])

  // 当前题号 = 已答题数（用 answers 长度代替 idx，便于用户返回后修改）
  const currentIdx = Object.keys(state.answers).length
  const current = questionList[currentIdx]
  const isLast = currentIdx === total - 1
  // 是否可以"上一题"：至少答过一题
  const canBack = currentIdx > 0
  // 是否可以"下一题 / 提交"：当前题已有答案
  const currentAnswer = current ? state.answers[current.id] : undefined
  const canNext = currentAnswer !== undefined

  function handleAnswer(value: AnswerValue): void {
    if (!current) return
    dispatch({ type: 'ANSWER', questionId: current.id, value })
  }

  function handleBack(): void {
    if (!canBack) return
    // 取上一题的 id，从 answers 中删掉对应键；不写新对象，reducer 里 replace
    const prevQuestion = questionList[currentIdx - 1]
    if (!prevQuestion) return
    // reducer 没有专门的"撤销一题" action；用 ANSWER 配合空值会被校验拒绝，所以加一个 SET_ANSWERS 风格
    // 这里直接派一个临时 action：使用 GO_TEST 会清空 answers，不合适。
    // 改方案：在 reducer 里加 UNDO_LAST；这里先用 dispatch action。
    dispatch({ type: 'UNDO_LAST', questionId: prevQuestion.id })
  }

  function handleNext(): void {
    if (!canNext) return
    if (!isLast) {
      // 触发一次 ANSWER 让 currentIdx+1；用 next 答案占位即可
      // 用 setTimeout 让 React 先刷一次渲染，再 dispatch 让 idx++
      // 但这里更干净：派发一个 GO_NEXT action（reducer 中实现）
      dispatch({ type: 'GO_NEXT' })
    } else {
      // 全部答完 → 计分并跳到结果页
      const result = score(state.answers, questionBank)
      dispatch({ type: 'GO_RESULT', result })
    }
  }

  if (!current) {
    // 理论上 currentIdx >= total 时不会有 current；兜底直接跳到结果
    const result = score(state.answers, questionBank)
    dispatch({ type: 'GO_RESULT', result })
    return <div />
  }

  const percent = Math.round(((currentIdx + (currentAnswer ? 1 : 0)) / total) * 100)

  return (
    <div className="setup-shell">
      <header className="setup-header">
        <h1 className="setup-title">人格测试</h1>
        <p className="setup-subtitle">根据直觉选 1-5 分，没有对错</p>
      </header>
      <div className="setup-body">
        <div className="progress">
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
        <div className="progress-meta">
          <span>
            进度 {Math.min(currentIdx + 1, total)} / {total}
          </span>
          <span>{percent}%</span>
        </div>

        <div className="question-card">
          <p className="question-text">{current.text}</p>
          <div className="scale-row">
            {[1, 2, 3, 4, 5].map((v) => (
              <button
                key={v}
                type="button"
                className={`scale-btn ${currentAnswer === v ? 'is-active' : ''}`}
                onClick={() => handleAnswer(v as AnswerValue)}
              >
                <span className="scale-num">{v}</span>
                <span className="scale-label">{SCALE_LABELS[v - 1]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <footer className="setup-footer">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleBack}
          disabled={!canBack}
        >
          上一题
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleNext}
          disabled={!canNext}
        >
          {isLast ? '完成测试' : '下一题'}
        </button>
      </footer>
    </div>
  )
}