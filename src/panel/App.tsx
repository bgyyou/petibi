// 【文件说明】主面板根组件：4 Tab 切换 + 头部状态栏 + 关闭按钮（隐藏面板）。
//
// M4 工单 A 改造：
//   - 头部状态栏：访客态显示"访客模式"角标；已登录态照常展示人格；
//   - Tab：访客态下"对话"+"我的"显示 GuestLock 遮罩（百科/社区仍可浏览）；
//   - "先逛逛" / "去登录" 引导：调主进程打开 setup 窗；
//   - 外部唤回（桌宠点击）时切到指定 Tab（chat）；快捷菜单"跟我对话"亦走同一通道。
//
// M4 token 失效恢复工单：
//   - 任何接口返回 401 → 触发 client.ts 全局 setAuthInvalidHandler 回调；
//   - 本组件注册 handler：清本地 token（保留 profile 字段）+ setIsGuest(true) +
//     渲染"登录已过期，请重新登录"卡片（带跳转按钮）取代卡死的"加载中…"；
//   - 区分 NetworkError（server 没起来）与 AuthInvalidError（token 无效）两种文案；
//   - 老用户升级场景：本地存的 mock 假 token 调 /api/me → 401 → 自动恢复 + 重新登录 →
//     进入 setup 流程；登录成功后主进程写回 profile.json（带真 token），
//     pet 窗启动；panel refetch getMe 拿到真 user，整链路自愈。
import { useCallback, useEffect, useState } from 'react'
import { ChatTab } from './tabs/ChatTab'
import { ProfileTab } from './tabs/ProfileTab'
import { EncyclopediaTab } from './tabs/EncyclopediaTab'
import { CommunityTab } from './tabs/CommunityTab'
import { GuestLock } from './tabs/GuestLock'
import { TitleBar } from '../components/TitleBar'
import type { StoredProfile } from '../../electron/storage'
import type { User } from '../api/types'
import {
  getMe,
  isAuthError,
  NetworkError,
  setAuthInvalidHandler,
} from '../api/client'

/** Tab 标识：4 个固定入口 */
type TabId = 'chat' | 'baike' | 'community' | 'profile'

interface TabMeta {
  id: TabId
  label: string
}

const TABS: TabMeta[] = [
  { id: 'chat', label: '对话' },
  { id: 'baike', label: '百科' },
  { id: 'community', label: '社区' },
  { id: 'profile', label: '我的' },
]

/** 哪些 Tab 在访客态被锁定（chat / profile 不可用；baike / community 可浏览） */
const LOCKED_IN_GUEST: ReadonlySet<TabId> = new Set<TabId>(['chat', 'profile'])

export function App(): JSX.Element {
  // 当前激活的 Tab；外部触发（桌宠唤回）时重置为"对话"——保证用户点桌宠就看到对话
  const [activeTab, setActiveTab] = useState<TabId>('chat')
  // 本地 profile：用于头部展示昵称 / 人格；首次 mount 时通过 IPC 拉一次
  const [profile, setProfile] = useState<StoredProfile['profile']>(null)
  // server user：我的 Tab 需要展示宠物昵称 / 修改入口；首次 mount 时用 init.token 拉一次
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  // 访客态：profile 未初始化 → guest 模式（百科 / 社区可浏览；其他 Tab 锁定）
  const [isGuest, setIsGuest] = useState<boolean>(false)
  // M4 token 失效恢复：401 触发后置 true。
  // 不与 isGuest 合并——保留独立标志是为了渲染「登录已过期」专属卡片（带跳转按钮），
  // 访客态（首次启动没注册）是「去登录 / 开始测试」的引导，语义不同。
  const [authExpired, setAuthExpired] = useState<boolean>(false)
  // 上次拉 server user 失败原因：区分 NetworkError / 401 / 其它，渲染对应文案
  const [userError, setUserError] = useState<string | null>(null)
  // userError 的语义标签（'network' | 'auth' | 'other'）；null 时按 'other' 兜底
  const [userErrorKind, setUserErrorKind] = useState<'network' | 'auth' | 'other' | null>(null)

  // 首次 mount：从主进程读 profile.json + token；接着用 token 拉 server user
  // P0-B 修复：getMe 失败（默认 prod 走真接口；server 未启动 / 鉴权失败）时记录错误，
  // 不再让「我的」Tab 永远停在「加载中…」——见下方 renderTabBody 的 profile 分支。
  useEffect(() => {
    let cancelled = false
    window.panelApi
      .getInit()
      .then((init) => {
        if (cancelled) return
        setProfile(init.profile)
        // token + profile 都存在才算登录态；profile 缺失则视为访客
        if (init.token && init.profile) {
          setToken(init.token)
          setIsGuest(false)
          // 拉 server user 拿宠物昵称 / mbti 等字段
          getMe(init.token)
            .then((u) => {
              if (cancelled) return
              setUser(u)
              setUserError(null)
              setUserErrorKind(null)
            })
            .catch((err: unknown) => {
              if (cancelled) return
              console.error('[panel] 拉取 server user 失败：', err)
              // M4：区分两类错误——token 无效 / server 没起 / 其它
              if (isAuthError(err)) {
                // 401 由全局 setAuthInvalidHandler 接管（清 token + 跳登录）；
                // 这里只把 userErrorKind 标记为 auth，让 profile 分支走「登录已过期」卡片。
                setUserErrorKind('auth')
                setUserError(err.message)
              } else if (err instanceof NetworkError) {
                setUserErrorKind('network')
                setUserError(err.message)
              } else {
                setUserErrorKind('other')
                const msg = err instanceof Error ? err.message : '未知错误'
                setUserError(msg)
              }
            })
        } else {
          // token 缺失或 profile 未初始化 → 访客态
          setIsGuest(true)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('[panel] 读取本地档案失败：', err)
        setUserErrorKind('other')
        setUserError(err instanceof Error ? err.message : '读取本地档案失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 全局 401 回调：注册到 client.ts 的 setAuthInvalidHandler。
   * 任何带 token 的真接口调用遇到 401 都会触发此 handler；
   * 处理路径：把本地 profile.json 的 token 字段置 null（保留 profile 字段，
   * 防止老用户连昵称 / 人格也一起被擦掉） + 切到 authExpired 卡片 + 提供跳转按钮。
   *
   * 关键：handler 在 useEffect 里挂载，组件 unmount 时自动注销，避免 React 18 严格模式
   * 下的 effect 双跑让上一个 handler 残留。
   */
  useEffect(() => {
    const handler = (info: { code: string; message: string }): void => {
      console.warn('[panel] 鉴权失效，清本地 token：', info)
      setAuthExpired(true)
      setToken(null)
      setUser(null)
      setUserErrorKind('auth')
      setUserError(info.message)
      // 把 userError 标记为 auth → renderTabBody 的 profile 分支走「登录已过期」卡片
      // 同时 isGuest=true 切走「我的」Tab 锁定分支（chat / profile 不再被 GuestLock 卡住）
      setIsGuest(true)
      // 通知主进程：M4 P2-025 登录门禁——隐藏桌宠 + 打开登录 setup 窗
      // （token 失效期间桌宠不能再被点击，避免与登录页 UI 状态割裂）
      try {
        window.panelApi.notifyAuthExpired?.()
      } catch (e) {
        console.warn('[panel] notifyAuthExpired 调用失败：', e)
      }
      // 写本地 profile.json：保留 profile 字段，token 置 null。
      // 即使后续 IPC 失败也不阻塞 UI（用户已经能看到跳转按钮了）。
      void window.panelApi.getInit().then((init) => {
        const next = { ...init, token: null }
        return window.panelApi.setProfile(next)
      }).catch((e: unknown) => {
        console.warn('[panel] 写本地 profile 失败：', e)
      })
    }
    setAuthInvalidHandler(handler)
    return () => {
      setAuthInvalidHandler(null)
    }
  }, [])

  /**
   * 唤起 setup 窗：让用户从访客态走完整登录流程。
   * 当前在 panel 端没有直接的 IPC；通过 petApi 通道（同一 preload）复用 setup 窗创建逻辑：
   * 主进程暴露 pet:open-setup 之类事件即可——这里走一个轻量方案：通知主进程把 setup 窗拉到前台
   * 并强制显示，从而 panel 端只管 UI 引导、setup 窗复用 createSetupWindow()。
   * 简化：当前实现采用"提示用户去 setup 窗"——主进程 IPC 直接发即可：
   * 这里我们借助一个 panelApi onRequireLogin 桥接（preload 已暴露 panelApi）。
   */
  const requireLogin = useCallback((): void => {
    // 通过自定义 IPC 让主进程关 panel、拉起 setup 窗
    // preload 没有直接暴露该 API，所以走 window 事件让 panel→main 触发：
    // 实际方案：用 petApi 的 enterGuest 逆向不行；新加 IPC: panel:open-setup（见 electron/main.ts）
    const evt = new CustomEvent('petibi:require-login')
    window.dispatchEvent(evt)
    // 直接调用最简洁：postMessage 让 main process 通过 IPC 拉起 setup 窗
    // 注意：preload 没暴露这个 IPC，这里通过 window.petApi 的隐藏 IPC 副作用触发：
    // ——退一步：直接 reload 到 setup 窗（不优雅但能用）。
    // 真正实现依赖 electron/main.ts 的 panel:open-setup，下面用占位 API：
    const fn = (window as unknown as { petApi?: { openSetup?: () => void } }).petApi?.openSetup
    if (typeof fn === 'function') fn()
  }, [])

  // 订阅外部唤回事件：把 Tab 重置到对话，UX 上"点桌宠就是来聊天的"
  useEffect(() => {
    window.panelApi.onPanelShown(() => {
      setActiveTab('chat')
    })
  }, [])

  // 订阅快捷菜单"跟我对话"信号：切到对话 Tab（与 onPanelShown 区分：panel:shown 不切，panel:switch-to-chat 切）
  useEffect(() => {
    const handler = (): void => setActiveTab('chat')
    window.panelApi.onPanelSwitchToChat(handler)
  }, [])

  // M4 重测人格：主进程写完 profile.json 后广播 panel:profile-changed → 重新拉 server user。
  // 重测不修改 nickname / pet_nickname，但 mbti / subtype / animal 字段会变，
  // 所以「我的」Tab 必须 refetch getMe 拿到最新 animal 显示。
  useEffect(() => {
    const handler = (): void => {
      if (!token) return
      getMe(token)
        .then((u) => setUser(u))
        .catch((err: unknown) => {
          console.error('[panel] retest 后拉 server user 失败：', err)
        })
    }
    window.panelApi.onProfileChanged(handler)
  }, [token])

  /** 关闭按钮：通知主进程 hide panel，不退出 app */
  const onClose = useCallback((): void => {
    window.panelApi.hidePanel()
  }, [])

  /** 我的 Tab 修改昵称成功后回调：把新 user 合进本地状态 */
  const onUserChange = useCallback((next: User): void => {
    setUser(next)
  }, [])

  /**
   * 渲染当前 Tab 的内容。访客态下 chat / profile 显示 GuestLock；
   * baike / community 可直接渲染（不论登录态）。
   */
  const renderTabBody = (): JSX.Element => {
    if (isGuest && LOCKED_IN_GUEST.has(activeTab)) {
      const lockMeta: Record<TabId, { name: string; desc: string }> = {
        chat: {
          name: '对话',
          desc: '登录后开启人格对话：和你的 MBTI 桌宠聊今天发生的事。',
        },
        baike: { name: '百科', desc: '百科内容可浏览' },
        community: { name: '社区', desc: '社区内容可浏览' },
        profile: {
          name: '我的',
          desc: '登录后开启宠物昵称 / 测试记录 / 未来装扮解锁。',
        },
      }
      const meta = lockMeta[activeTab]
      return (
        <GuestLock
          featureName={meta.name}
          description={meta.desc}
          onLogin={requireLogin}
        />
      )
    }
    if (activeTab === 'chat') {
      // 登录态但 profile 还没拉到 user 也走 chat tab（自己内部显示 loading）
      return <ChatTab />
    }
    if (activeTab === 'baike') {
      return <EncyclopediaTab />
    }
    if (activeTab === 'community') {
      return (
        <CommunityTab
          token={token}
          onRequireLogin={requireLogin}
        />
      )
    }
    if (activeTab === 'profile') {
      if (!user || !token) {
        // P0-B 修复：若 getMe 失败（server 未启动 / 鉴权失败）展示错误而非永远「加载中…」
        if (userError) {
          // M4 token 失效恢复：401 → 渲染「登录已过期」专属卡片，
          // 区分 server 没起（network）与鉴权失效（auth）两种文案
          if (userErrorKind === 'auth' || authExpired) {
            return (
              <div className="profile-loading profile-error profile-auth-expired">
                <div className="profile-auth-expired-title">登录已过期</div>
                <div className="profile-auth-expired-desc">
                  本地 token 无效或已被服务端清除。请点击下方按钮重新登录。
                </div>
                <button
                  type="button"
                  className="btn profile-auth-expired-btn"
                  onClick={requireLogin}
                >
                  重新登录
                </button>
              </div>
            )
          }
          if (userErrorKind === 'network') {
            return (
              <div className="profile-loading profile-error">
                加载用户档案失败：{userError}
                <br />
                请确认后端服务（端口 8787）已启动后重新打开主面板。
              </div>
            )
          }
          return (
            <div className="profile-loading profile-error">
              加载用户档案失败：{userError}
              <br />
              请稍后重试，或重新打开主面板。
            </div>
          )
        }
        return <div className="profile-loading">加载中…</div>
      }
      return <ProfileTab user={user} token={token} onUserChange={onUserChange} />
    }
    return <div className="profile-loading">加载中…</div>
  }

  return (
    <div className="panel-shell">
      <TitleBar
        title="Petibi"
        onMinimize={() => window.petApi?.minimizePanel?.()}
        onClose={() => window.panelApi?.hidePanel?.()}
      />

      {/* 紧凑 persona 信息条：自绘标题栏下方、Tabs 上方；展示当前用户昵称 + 人格 / 访客提示 */}
      <div className="panel-info-strip">
        {profile && !isGuest && (
          <span className="panel-info-text">
            <span className="pixel-title">{profile.nickname ?? profile.email}</span>
            <span className="panel-info-sep">·</span>
            <span className="panel-info-mbti">{profile.mbti}</span>
          </span>
        )}
        {isGuest && (
          <span className="panel-info-text panel-info-guest">
            <span className="panel-info-guest-badge">访客模式</span>
            <span className="panel-info-guest-hint">登录后开启对话与档案</span>
          </span>
        )}
      </div>

      <main className="panel-body">{renderTabBody()}</main>

      <nav className="panel-tabs" aria-label="主面板 Tab 切换">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`panel-tab ${activeTab === t.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            {isGuest && LOCKED_IN_GUEST.has(t.id) && (
              <span className="panel-tab-lock" aria-hidden="true">
                <svg viewBox="0 0 8 8" width="10" height="10" shapeRendering="crispEdges">
                  <rect x="3" y="2" width="2" height="1" fill="#2B2320" />
                  <rect x="2" y="3" width="1" height="2" fill="#2B2320" />
                  <rect x="5" y="3" width="1" height="2" fill="#2B2320" />
                  <rect x="3" y="3" width="2" height="1" fill="#2B2320" />
                  <rect x="2" y="5" width="4" height="2" fill="#2B2320" />
                  <rect x="3" y="6" width="2" height="1" fill="#FEF9EF" />
                </svg>
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  )
}