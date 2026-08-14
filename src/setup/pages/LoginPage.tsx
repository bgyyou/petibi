// 【文件说明】登录页（PRD §3.1 / M5 登录页设计升级）：邮箱 + 6 位验证码，对接 M3 契约 §4 接口。
//
// M5 登录页设计升级（DESIGN.md v1 + owner 实测反馈"中部留白大、无品牌感"）：
//   - 在 form 上方新增视觉主体：Petibi logo + 主 Slogan「遇事不决，问问你的人格」 +
//     16 人格像素形象墙（4×4 网格，resources/sprites/<type>/base.png 64×64 base frame，
//     通过 IPC data URL 加载，与百科 Tab / ResultPage 同源，详见 loadSpriteDataUrl）；
//   - 登录表单（邮箱 + 验证码 + 下一步 + 先逛逛入口）保持现有功能不动，只调整视觉位置；
//   - 自绘标题栏保持不变（DESIGN.md §6：TitleBar 已由 App.tsx 包好）；
//   - 像素大字用 .pixel-title / .pixel-title-cn（DESIGN.md §4 字体节奏）；
//   - 16 sprite 按 src/setup/persona-meta.ts PERSONAS 顺序（4 族 × 4 字母）排列，
//     每行对应一族，族色作为该行顶条 / sprite 占位底色。
//
// M4 内嵌 server 工单补充（保留）：
//   - 内嵌 server 启动时设 PETIBI_EMBED=1，server 在 dev 模式下把 devCode 直接返回；
//   - 本组件在 sendEmailCode 拿到 devCode 后，把验证码显示在 UI 上，
//     文案「本地模式验证码：517754」（替换 mock 时代的固定 123456 提示）；
//   - 验证码仅在 dev / mock 模式出现；生产环境 devCode 为 undefined，不渲染横幅。
//
// M4 token 失效恢复工单（保留）：
//   - 老用户本地 profile.json 里存的是 mock 时代假 token，登录页校验失败会跳到这里；
//   - verifyEmailCode 成功 → 服务端返回的 user.mbti 已存在 → 老用户；
//   - 老用户登录：直接写本地 profile（保留 user.mbti / subtype / nickname）+
//     completeSetup（关 setup 窗、开 pet 窗），不再走 nickname/pick/test/result 流程；
//   - 新用户登录：依然 dispatch LOGIN_SUCCESS → 走原本的 5 步初始化。
import { useEffect, useState } from 'react'
import { isMockMode, sendEmailCode, verifyEmailCode, ApiCallError } from '../../api/client'
import { useSetup } from '../state/setupStore'
import { PERSONAS, FAMILY_COLORS, type MbtiType } from '../persona-meta'

/**
 * 渲染端 sprite data URL 缓存：模块级 singleton，避免每次重渲染重复打 IPC。
 * key 形如 `<type>`，value 是 data:image/png;base64,... 字符串；null 表示读失败。
 * 与 EncyclopediaTab 的 spriteDataUrlCache 同源策略（panel 窗用），这里 login 窗复用。
 */
const spriteDataUrlCache: Map<string, string | null> = new Map()

/** 拉取人格 sprite 的 data URL（带缓存）；返回 null 表示文件缺失 / 人格非法 */
async function loadSpriteDataUrl(type: MbtiType): Promise<string | null> {
  const cached = spriteDataUrlCache.get(type)
  if (cached !== undefined) return cached
  const api = window.petApi
  let data: string | null = null
  if (api && typeof api.getSpriteDataUrl === 'function') {
    try {
      data = await api.getSpriteDataUrl(type, 'idle_0')
    } catch (err) {
      console.warn(`[LoginPage] 拉取 ${type} sprite 失败：`, err)
      data = null
    }
  }
  spriteDataUrlCache.set(type, data)
  return data
}

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
  // M5 登录页设计升级：16 人格 sprite data URL 表（key = mbti）
  const [spriteDataUrls, setSpriteDataUrls] = useState<Record<string, string>>({})

  const emailValid = EMAIL_RE.test(email)
  const codeValid = /^\d{6}$/.test(code)

  // M5 登录页：拉 16 人格 idle_0 sprite（一次性，并发 ~1KB/帧）
  // 与 EncyclopediaTab 的 spriteDataUrls 实现同源；这里没用 React.lazy 因为登录页是首屏
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const results = await Promise.all(
        PERSONAS.map(async (p) => {
          const url = await loadSpriteDataUrl(p.type)
          return { type: p.type, url }
        }),
      )
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const { type, url } of results) {
        if (url) next[type] = url
      }
      setSpriteDataUrls(next)
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
        {/*
          M5 登录页设计升级：把 setup-title 改为"Petibi logo + 大字 slogan"。
          - logo：复用 TitleBar 默认的 8×8 像素点阵（与 src/components/TitleBar.tsx 同款色板）
          - slogan：像素字体大标题（DESIGN.md §4 字号节奏 + .pixel-title-cn 类）
          - 副标题保留：原有"邮箱登录，开始你的 MBTI 之旅"
        */}
        <div className="login-brand">
          <div className="login-brand-logo" aria-hidden="true">
            <LoginPageLogo />
          </div>
          <div className="login-brand-titles">
            <h1 className="login-slogan pixel-title-cn">遇事不决，问问你的人格</h1>
            <p className="setup-subtitle">邮箱登录，开启与 16 个像素人格的对话</p>
          </div>
        </div>
      </header>

      <div className="setup-body">
        {/*
          M5 登录页设计升级：16 人格像素形象墙。
          - 4×4 网格，每行对应一族（与 PERSONAS 顺序一致）；
          - 每格：族色底纹 + sprite 居中 + MBTI 缩写标签；
          - sprite 走 IPC data URL 加载（window.petApi.getSpriteDataUrl），与百科 Tab 同源；
          - 像素感：image-rendering: pixelated + 3px 墨色描边 + 4px 硬阴影。
        */}
        <div
          className="login-persona-wall"
          aria-label="16 人格像素形象墙"
          data-testid="login-persona-wall"
        >
          {PERSONAS.map((p) => {
              const colors = FAMILY_COLORS[p.family]
              const spriteSrc = spriteDataUrls[p.type]
              return (
                <div
                  key={p.type}
                  className="login-persona-tile"
                  style={{ borderColor: colors.border, background: colors.bg }}
                  data-family={p.family}
                  title={`${p.type} · ${p.animal}`}
                >
                  <div
                    className="login-persona-tile-strip"
                    style={{ background: colors.fg }}
                    aria-hidden="true"
                  />
                  {spriteSrc ? (
                    <img
                      src={spriteSrc}
                      width={48}
                      height={48}
                      alt={`${p.animal} ${p.type}`}
                      className="login-persona-tile-sprite"
                      draggable={false}
                    />
                  ) : (
                    <div
                      className="login-persona-tile-sprite login-persona-tile-sprite-placeholder"
                      aria-label={p.animal}
                      role="img"
                    />
                  )}
                  <div
                    className="login-persona-tile-label"
                    style={{ color: colors.fg }}
                  >
                    {p.type}
                  </div>
                </div>
              )
            })}
        </div>

        <hr className="pixel-divider" aria-hidden="true" />

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

/**
 * M5 登录页 logo：与 TitleBar 默认 logo 同源（8×8 像素点阵），但放大到 24×24，
 * 像素感更强，并加紫 + 绿 + 蓝 + 黄四族色条带——视觉锚点"16 人格在这里等你"。
 */
function LoginPageLogo(): JSX.Element {
  // 12×12 像素画：
  //   - 描边 + 中心 Petibi 字母"P"风格的阶梯像素
  //   - 左 4 列紫族色 / 右 4 列绿族色 / 中间 4 列"Petibi P"风格像素
  const colorMap = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 0],
    [0, 1, 2, 3, 3, 2, 2, 2, 2, 2, 1, 0],
    [0, 1, 2, 3, 3, 2, 2, 2, 2, 2, 1, 0],
    [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 0],
    [0, 1, 1, 4, 4, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 4, 4, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ]
  // 配色：0=墨边、1=墨色描边、2=紫族色、3=奶油中心、4=绿族色（第二族色作对角呼应）
  const palette = ['transparent', '#2B2320', '#785D87', '#FEF9EF', '#3E8F6E']
  return (
    <div className="login-brand-logo-grid" aria-hidden="true">
      {colorMap.flatMap((row, y) =>
        row.map((v, x) => (
          <span
            key={`${x}-${y}`}
            style={{
              gridColumn: x + 1,
              gridRow: y + 1,
              background: palette[v] ?? 'transparent',
            }}
          />
        )),
      )}
    </div>
  )
}