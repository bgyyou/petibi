// 【文件说明】结果页（PRD §3.2 / 自验清单第 4 条）：
//   - 显示 type + subtype（坚定型/善感型）+ 动物名 + 32×32 桌宠 sprite；
//   - 「结果符合你吗」反馈按钮（很符合 / 不太符合）→ 落库（mock 或真接口）；
//   - 用户点"完成" → 写本地 profile.json + 通知主进程 completeSetup 切到 pet 窗。
import { useEffect, useState } from 'react'
import { useSetup } from '../state/setupStore'
import {
  FAMILY_COLORS,
  SUBTYPE_LABELS,
  getPersona,
  type PersonaMeta,
} from '../persona-meta'
import { saveProfile, submitFeedback, ApiCallError } from '../../api/client'
import { FEEDBACK_NO, FEEDBACK_YES } from '../uiHints'

export function ResultPage(): JSX.Element {
  const { state, dispatch } = useSetup()

  // 结果可能来自"直接选用"或"测试"两条路径，必须都把 type/subtype 渲染出来
  const resultType = state.result?.type ?? state.pickedType ?? ''
  const resultSubtype = state.result?.subtype ?? 'stable'
  // pickedType 没有 subtype 信息，按 stable 占位（UI 显示固定标签）
  const meta: PersonaMeta | null = getPersona(resultType)
  const familyColors = meta ? FAMILY_COLORS[meta.family] : null

  const [feedbackMatch, setFeedbackMatch] = useState<boolean | null>(null)
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackDone, setFeedbackDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 自动提交 feedback（用户选了某项即触发一次）
  useEffect(() => {
    if (feedbackMatch === null) return
    if (!state.token) {
      setError('登录态已失效，请重启初始化')
      return
    }
    let cancelled = false
    setFeedbackSubmitting(true)
    setError(null)
    submitFeedback(state.token, { match: feedbackMatch })
      .then(() => {
        if (cancelled) return
        setFeedbackDone(true)
        dispatch({ type: 'FEEDBACK_RECORDED' })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiCallError ? err.message : '反馈提交失败，请稍后再试')
      })
      .finally(() => {
        if (!cancelled) setFeedbackSubmitting(false)
      })
    return () => {
      cancelled = true
    }
  }, [feedbackMatch, state.token, dispatch])

  async function handleComplete(): Promise<void> {
    if (!state.token || !resultType || !meta) {
      setError('数据不完整，请返回重选')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // 1) 通知服务端保存 profile（mock 模式直接落内存）
      const user = await saveProfile(state.token, {
        nickname: state.nickname,
        mbti: resultType,
        subtype: resultSubtype,
      })
      // 2) 写本地 profile.json（含 token + profile，pet 窗下次启动据此跳过 setup）
      await window.petApi.setProfile({
        token: state.token,
        profile: {
          email: state.email || user.email,
          nickname: state.nickname,
          mbti: resultType,
          subtype: resultSubtype,
          createdAt: new Date().toISOString(),
        },
      })
      // 3) 通知主进程：关 setup、开 pet
      window.petApi.completeSetup()
    } catch (err) {
      setError(err instanceof ApiCallError ? err.message : '保存失败，请稍后再试')
      setSaving(false)
    }
  }

  if (!resultType || !meta || !familyColors) {
    return (
      <div className="setup-shell">
        <header className="setup-header">
          <h1 className="setup-title">未拿到结果</h1>
        </header>
        <div className="setup-body">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => dispatch({ type: 'BACK_TO_PICK' })}
          >
            返回选择
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="setup-shell">
      <header className="setup-header">
        <h1 className="setup-title">你的人格是…</h1>
        <p className="setup-subtitle">它就是你专属的桌宠形象</p>
      </header>
      <div className="setup-body">
        <div className="result-shell">
          <div
            className="result-card"
            style={{ borderColor: familyColors.border, background: '#ffffff' }}
          >
            <img
              src={window.petApi.spriteUrl(resultType, 'idle_0')}
              width={128}
              height={128}
              alt={`${resultType} 桌宠`}
              className="result-portrait"
              draggable={false}
            />
            <div className="result-type" style={{ color: familyColors.fg }}>
              {resultType}
            </div>
            <div className="result-subtype" style={{ background: familyColors.bg, color: familyColors.fg }}>
              {SUBTYPE_LABELS[resultSubtype]}
            </div>
            <div className="result-animal">{meta.animal} · {meta.tagline}</div>
          </div>

          <div style={{ fontSize: 13, color: '#5e5e58' }}>结果符合你吗？</div>
          <div className="feedback-row">
            <button
              type="button"
              className={`btn-feedback ${feedbackMatch === true ? 'is-active' : ''}`}
              onClick={() => setFeedbackMatch(true)}
              disabled={feedbackSubmitting}
            >
              {FEEDBACK_YES}
            </button>
            <button
              type="button"
              className={`btn-feedback ${feedbackMatch === false ? 'is-active' : ''}`}
              onClick={() => setFeedbackMatch(false)}
              disabled={feedbackSubmitting}
            >
              {FEEDBACK_NO}
            </button>
          </div>
          {feedbackDone && (
            <div className="feedback-confirm">反馈已记录，感谢！</div>
          )}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <footer className="setup-footer">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => dispatch({ type: 'BACK_TO_PICK' })}
        >
          重选人格
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleComplete}
          disabled={saving}
        >
          {saving ? '保存中…' : '完成，去和你的桌宠玩'}
        </button>
      </footer>
    </div>
  )
}