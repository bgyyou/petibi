// 【文件说明】结果页（PRD §3.2 / T3 工单第 4 条 P2-023）：
//   - 大字人格（4 字母 MBTI，DESIGN.md §4 字号节奏 40px）+ 细分标签（坚定型/善感型）
//   - **四维百分比条**（每维两字母对比：E 51% / I 49%，族色填充；宽度按 score().percentages 取值）
//   - 某维度落在 45%-55% 时显示提示「这个维度你的倾向较弱，结果可能随状态波动」
//   - 数据来源：setupStore.state.result.percentages（来自 src/scoring/score.ts score() 返回值）
//   - 直接选人格（无 percentages）路径只显示人格 + 细分，不显示百分比条
//   - 反馈按钮 + 完成按钮（同 M2 行为）；完成按钮触发 completeSetup 切到 pet 窗
//
// M4 重测人格（mode='retest'）：handleComplete 走 notifyRetestComplete 而非 completeSetup
//   - 主进程负责：写 profile.json（覆盖 mbti/subtype）+ 广播 pet:sprite-change + 关 setup 窗；
//   - pet 窗已存在，不调 completeSetup（避免重复创建 pet）。
//   - 重测时不再要求用户重新选昵称 / 重新反馈（既已登录，昵称已设；重测关注点只是人格）。
//
// M4 setup 返回导航：左上角加统一「← 返回」按钮（替换原本 footer 的"重选人格"按钮）。
//   - BACK_TO_PICK 只切 step 不清 result（reducer 既有契约）；
//   - 进入选人格页后用户可重新 PICK_TYPE/GO_TEST，reducer 会清 result 完成 P0-005 防御；
//   - fallback 分支（无 result 数据）也有统一返回按钮。
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
import { BackButton } from './BackButton'

/** setup 结果页 / 详情页用的 sprite frame；单帧静态展示 */
const RESULT_SPRITE_FRAME = 'idle_0' as const

/** 四维定义：键 + 第一极 + 第二极 + 中文标题（DESIGN.md §4 / R5 极性） */
const DIM_ROWS: Array<{
  key: 'EI' | 'SN' | 'TF' | 'JP'
  first: string
  second: string
  name: string
}> = [
  { key: 'EI', first: 'E', second: 'I', name: '能量来源' },
  { key: 'SN', first: 'S', second: 'N', name: '信息接收' },
  { key: 'TF', first: 'T', second: 'F', name: '决策方式' },
  { key: 'JP', first: 'J', second: 'P', name: '生活态度' },
]

/** 弱倾向判定阈值：45% – 55%（即第一极在 [45, 55] 时显示提示文案） */
const WEAK_PCT_LOW = 45
const WEAK_PCT_HIGH = 55

export function ResultPage(): JSX.Element {
  const { state, dispatch } = useSetup()

  // 结果可能来自"直接选用"或"测试"两条路径，必须都把 type/subtype 渲染出来
  const resultType = state.result?.type ?? state.pickedType ?? ''
  const resultSubtype = state.result?.subtype ?? 'stable'
  // pickedType 没有 subtype 信息，按 stable 占位（UI 显示固定标签）
  const meta: PersonaMeta | null = getPersona(resultType)
  const familyColors = meta ? FAMILY_COLORS[meta.family] : null

  // percentages：只有走测试路径才有；pickedType 没有（工单约定只显示人格+细分）
  const percentages = state.result?.percentages ?? null

  const [feedbackMatch, setFeedbackMatch] = useState<boolean | null>(null)
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackDone, setFeedbackDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // P0-A 修复：结果页 sprite 走 IPC data URL，避免 setup HTML 位于
  // out/renderer/setup/index.html 时相对路径解析到不存在的子目录
  const [spriteSrc, setSpriteSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!resultType || !meta) {
      setSpriteSrc(null)
      return
    }
    const api = window.petApi
    if (!api || typeof api.getSpriteDataUrl !== 'function') {
      setSpriteSrc(null)
      return
    }
    void api.getSpriteDataUrl(resultType, RESULT_SPRITE_FRAME)
      .then((url) => {
        if (!cancelled) setSpriteSrc(url)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn('[ResultPage] 拉取 sprite 失败：', err)
          setSpriteSrc(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [resultType, meta])

  // 自动提交 feedback（用户选了某项即触发一次）。
  // P0-006 红线：反馈成功后 **绝对不能** 触发 completeSetup 或窗口关闭——
  // 用户必须自行点击 footer 的"完成"按钮才能切到桌宠窗。
  useEffect(() => {
    if (feedbackMatch === null) return
    if (!state.token) {
      setError('登录态已失效，请重启初始化')
      return
    }
    let cancelled = false
    setFeedbackSubmitting(true)
    setError(null)
    submitFeedback(state.token, {
      mbti: resultType,
      subtype: resultSubtype,
      accepted: feedbackMatch,
    })
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
  }, [feedbackMatch, state.token, resultType, resultSubtype, dispatch])

  async function handleComplete(): Promise<void> {
    if (feedbackSubmitting) {
      setError('反馈正在提交中，请稍候再完成')
      return
    }
    if (!state.token || !resultType || !meta) {
      setError('数据不完整，请返回重选')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // 重测模式下，server /api/me/profile 仍要同步（让 server 侧 user 记录也更新），
      // 但 local profile.json 不能再用 currentMbti/now() 覆盖 createdAt，必须保留旧值。
      if (state.mode === 'retest') {
        // server 同步：用当前已有的昵称（不重置），只覆盖 mbti / subtype
        await saveProfile(state.token, {
          nickname: state.nickname,
          mbti: resultType,
          subtype: resultSubtype,
        })
        // 主进程负责读旧 profile.json、保留 email/nickname/createdAt，覆盖 mbti/subtype，
        // 然后广播 pet:sprite-change + 关 setup 窗。渲染端不再写 profile.json（避免冲突）。
        window.petApi.notifyRetestComplete({
          mbti: resultType,
          subtype: resultSubtype,
        })
        // 不调 completeSetup（pet 窗已存在）——不再走 transitionSetupToPet
        return
      }
      // initial 模式：M2/M3/M4 既有路径——saveProfile + setProfile + completeSetup
      const user = await saveProfile(state.token, {
        nickname: state.nickname,
        mbti: resultType,
        subtype: resultSubtype,
      })
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
      window.petApi.completeSetup()
    } catch (err) {
      setError(err instanceof ApiCallError ? err.message : '保存失败，请稍后再试')
      setSaving(false)
    }
  }

  // M4 返回导航：结果页 → 选人格页（reducer 只切 step，不清 result，
  // 由后续 PICK_TYPE/GO_TEST 在选人格页清理；与既有 BACK_TO_PICK 契约一致）
  function handleBackToPick(): void {
    dispatch({ type: 'BACK_TO_PICK' })
  }

  if (!resultType || !meta || !familyColors) {
    return (
      <div className="setup-shell">
        <BackButton onClick={handleBackToPick} label="重选人格" step="result" />
        <header className="setup-header">
          <h1 className="setup-title">未拿到结果</h1>
        </header>
        <div className="setup-body" />
      </div>
    )
  }

  return (
    <div
      className="setup-shell"
      style={{
        // 注入族色变量，结果页所有卡片 / 按钮 / 百分比条都用族色（DESIGN.md §2）
        ['--family-color' as string]: familyColors.fg,
        ['--family-color-bg' as string]: familyColors.bg,
      }}
    >
      <BackButton onClick={handleBackToPick} label="重选人格" step="result" />
      <header className="setup-header">
        <h1 className="setup-title">你的人格是…</h1>
        <p className="setup-subtitle">它就是你专属的桌宠形象</p>
      </header>
      <div className="setup-body">
        <div className="result-shell">
          {/* 人格大字 + 细分标签卡片 */}
          <div className="result-card">
            {spriteSrc ? (
              <img
                src={spriteSrc}
                width={128}
                height={128}
                alt={`${resultType} 桌宠`}
                className="result-portrait"
                draggable={false}
              />
            ) : (
              <div
                className="result-portrait result-portrait-placeholder"
                aria-label={`${resultType} 桌宠`}
                role="img"
              />
            )}
            <div className="result-type">{resultType}</div>
            <div className="result-subtype">
              {SUBTYPE_LABELS[resultSubtype]}
            </div>
            <div className="result-animal">
              {meta.animal} · {meta.tagline}
            </div>
          </div>

          {/* 四维百分比条（P2-023 / T3 第 4 条）：只有走测试路径（percentages 存在）才显示 */}
          {percentages && (
            <div className="result-bars" aria-label="四维百分比">
              {DIM_ROWS.map((row) => {
                // firstPct 是第一极百分比（0-100）；第二极就是 100 - firstPct
                const firstPct = percentages[row.key]
                const secondPct = 100 - firstPct
                // 弱倾向：第一极百分比落在 [45, 55]
                const isWeak =
                  firstPct >= WEAK_PCT_LOW && firstPct <= WEAK_PCT_HIGH
                return (
                  <div key={row.key} className="result-bar">
                    <div className="result-bar-name">{row.name}</div>
                    <div className="result-bar-row">
                      <span className="result-bar-pole is-first">{row.first}</span>
                      <div
                        className="result-bar-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={firstPct}
                        aria-label={`${row.first} ${firstPct}%`}
                      >
                        <div
                          className="result-bar-fill"
                          style={{ width: `${firstPct}%` }}
                        />
                      </div>
                      <span className="result-bar-pole is-second">{row.second}</span>
                    </div>
                    <div className="result-bar-pct">
                      <span>{row.first} {firstPct.toFixed(0)}%</span>
                      <span>{row.second} {secondPct.toFixed(0)}%</span>
                    </div>
                    {isWeak && (
                      <div className="result-bar-hint">
                        这个维度你的倾向较弱，结果可能随状态波动
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* 反馈按钮行 */}
          <div style={{ fontSize: 13, color: 'var(--mute)', marginTop: 4 }}>
            结果符合你吗？
          </div>
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
        {/* M4 setup 返回导航：footer 移除"重选人格"按钮，统一改用左上角 BackButton。
            完成按钮保留：触发 completeSetup / notifyRetestComplete 主进程链路。 */}
        <span style={{ fontSize: 12, color: 'var(--mute)' }}>
          {state.mode === 'retest' ? '重测：覆盖当前人格' : '反馈已记录后即可完成'}
        </span>
        <button
          type="button"
          className="btn"
          onClick={handleComplete}
          disabled={saving}
        >
          {saving
            ? '保存中…'
            : state.mode === 'retest'
              ? '确认更换人格'
              : '完成，去和你的桌宠玩'}
        </button>
      </footer>
    </div>
  )
}