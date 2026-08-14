// 【文件说明】登录页（PRD §3.1）：邮箱 + 6 位验证码，对接 M3 契约 §4 接口。
//
// M4 内嵌 server 工单补充：
//   - 内嵌 server 启动时设 PETIBI_EMBED=1，server 在 dev 模式下把 devCode 直接返回；
//   - 本组件在 sendEmailCode 拿到 devCode 后，把验证码显示在 UI 上，
//     文案「本地模式验证码：517754」（替换 mock 时代的固定 123456 提示）；
//   - 验证码仅在 dev / mock 模式出现；生产环境 devCode 为 undefined，不渲染横幅。
//
// M4 token 失效恢复工单：老用户升级场景
//   - 老用户本地 profile.json 里存的是 mock 时代假 token，登录页校验失败会跳到这里；
//   - verifyEmailCode 成功 → 服务端返回的 user.mbti 已存在 → 老用户；
//   - 老用户登录：直接写本地 profile（保留 user.mbti / subtype / nickname）+
//     completeSetup（关 setup 窗、开 pet 窗），不再走 nickname/pick/test/result 流程；
//   - 新用户登录：依然 dispatch LOGIN_SUCCESS → 走原本的 5 步初始化。
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
  /** dev / mock 模式由 server 直接返回的验证码；生产环境始终为 null（不渲染横幅） */
  const [devCode, setDevCode] = useState<string | null>(null)

  const emailValid = EMAIL_RE.test(email)
  const codeValid = /^\d{6}$/.test(code)

  // 发送验证码：触发真接口、起 60s 倒计时；dev 模式把 devCode 回填到 UI 便于联调
  async function handleSendCode(): Promise<void> {
    setError(null)
    if (!emailValid) {
      setError('请输入合法邮箱地址')
      return
    }
    try {
      const res = await sendEmailCode(email)
      // dev / mock 模式：devCode 是字符串；生产模式是 undefined
      if (typeof res.devCode === 'string' && res.devCode.length > 0) {
        setDevCode(res.devCode)
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
      // M4 老用户直通：user.mbti 已存在 → 直接写本地 profile + pet + panel 双开，
      // 不再走 nickname / pick / test / result 流程；与第一次登录体验一致。
      // M4 P2-025 Bug 2 修复：用 completeSetupForExistingUser 替代 completeSetup，
      // 让主进程同时拉起桌宠 + 主面板——桌面宠物应用的"常伴面板"姿态（owner 实测）。
      if (res.user.mbti) {
        await window.petApi.setProfile({
          token: res.token,
          profile: {
            email: res.user.email,
            nickname: res.user.nickname ?? res.user.email,
            mbti: res.user.mbti,
            subtype: res.user.subtype ?? 'stable',
            // 老用户 createdAt：server 端首次写档时间。fetchEmailCode 响应 User 不含 createdAt，
            // 这里填当前 ISO 字符串作为占位（实际是已有用户，不是首次创建，无关紧要）。
            createdAt: new Date().toISOString(),
          },
        })
        window.petApi.completeSetupForExistingUser()
        return
      }
      // 新用户：进入 setup 流程的 nickname 步骤
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
        {/*
          M4 内嵌 server 工单：mock 模式（VITE_USE_MOCK_API=true）下 server 没启动，
          仍走 src/api/client.ts 的 mockSendCode，返回 devCode='123456'。
          真接口 dev 模式（embedded server 已启动）也返回 devCode，UI 同样展示。
          生产环境 devCode 是 undefined，整段 banner 不渲染。
        */}
        {devCode && (
          <div className="mock-banner" title="仅 dev / mock 模式显示验证码">
            本地模式验证码：<strong>{devCode}</strong>
          </div>
        )}
        {/*
          保留旧的 mock 模式 123456 提示：当 VITE_USE_MOCK_API=true 但 devCode 还没回填时
          也能让用户知道「可以填 123456」，避免 dev 联调时瞎试。
          当 devCode 回填后这条横幅会被覆盖。
        */}
        {isMockMode && !devCode && (
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
        </div>
      </div>
      <footer className="setup-footer">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--mute)' }}>登录即同意《用户协议》《隐私政策》</span>
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