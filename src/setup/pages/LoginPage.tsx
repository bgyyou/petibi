// 【文件说明】登录页（PRD §3.1）：邮箱 + 6 位验证码，对接 M3 契约 §4 接口。
// mock 模式默认开启，验证码固定 123456（见 src/api/client.ts 的 mockGenerateCode）。
import { useState } from 'react'
import { isMockMode, sendEmailCode, verifyEmailCode, ApiCallError } from '../../api/client'
import { useSetup } from '../state/setupStore'

// 邮箱合法性轻校验：与后端校验保持一致（基本形态，不做 DNS）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function LoginPage(): JSX.Element {
  const { dispatch } = useSetup()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  // 0=未发送 1=已发送倒计时
  const [cooldown, setCooldown] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devCode, setDevCode] = useState<string | null>(null)

  const emailValid = EMAIL_RE.test(email)
  const codeValid = /^\d{6}$/.test(code)

  // 发送验证码：触发 mock 接口、起 60s 倒计时；mock 模式把 dev_code 回填到 UI 便于演示
  async function handleSendCode(): Promise<void> {
    setError(null)
    if (!emailValid) {
      setError('请输入合法邮箱地址')
      return
    }
    try {
      const res = await sendEmailCode(email)
      if (res.dev_code) {
        setDevCode(res.dev_code)
      }
      setCooldown(60)
      const timer = setInterval(() => {
        setCooldown((prev) => {
          if (prev <= 1) {
            clearInterval(timer)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    } catch (err) {
      setError(formatError(err))
    }
  }

  async function handleVerify(): Promise<void> {
    setError(null)
    if (!emailValid || !codeValid) {
      setError('请输入合法邮箱与 6 位验证码')
      return
    }
    setSubmitting(true)
    try {
      const res = await verifyEmailCode(email, code)
      // 进入下一步
      dispatch({ type: 'LOGIN_SUCCESS', email: res.user.email, token: res.token })
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="setup-shell">
      <header className="setup-header">
        <h1 className="setup-title">欢迎来到 Petibi</h1>
        <p className="setup-subtitle">邮箱登录，开始你的 MBTI 之旅</p>
      </header>
      <div className="setup-body">
        {isMockMode && (
          <div className="mock-banner" title="server 暂未就绪，当前走本地 mock 接口">
            mock 模式：验证码固定 123456
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="code">验证码</label>
          <div className="btn-row">
            <input
              id="code"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="6 位数字"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleSendCode}
              disabled={!emailValid || cooldown > 0}
            >
              {cooldown > 0 ? `${cooldown}s 后重试` : '发送验证码'}
            </button>
          </div>
          {devCode && (
            <div className="field-error" style={{ color: '#2e6e4f' }}>
              mock 验证码：{devCode}
            </div>
          )}
        </div>
      </div>
      <footer className="setup-footer">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span style={{ fontSize: 12, color: '#8a8a86' }}>登录即同意《用户协议》《隐私政策》</span>
          {/* M4 工单 A3 访客模式：不登录直接逛百科 / 社区入口 */}
          <button
            type="button"
            className="btn btn-link"
            onClick={() => window.petApi.enterGuest()}
            style={{ padding: 0 }}
          >
            先逛逛（不登录）
          </button>
        </div>
        <button
          type="button"
          className="btn"
          onClick={handleVerify}
          disabled={!emailValid || !codeValid || submitting}
        >
          {submitting ? '验证中…' : '下一步'}
        </button>
      </footer>
    </div>
  )
}

function formatError(err: unknown): string {
  if (err instanceof ApiCallError) return err.message
  if (err instanceof Error) return err.message
  return '请求失败，请稍后再试'
}