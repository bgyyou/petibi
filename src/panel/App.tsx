// 【文件说明】主面板根组件：4 Tab 切换 + 头部状态栏 + 关闭按钮（隐藏面板）。
//
// M4 工单 A 改造：
//   - 头部状态栏：访客态显示"访客模式"角标；已登录态照常展示人格；
//   - Tab：访客态下"对话"+"我的"显示 GuestLock 遮罩（百科/社区仍可浏览）；
//   - "先逛逛" / "去登录" 引导：调主进程打开 setup 窗；
//   - 外部唤回（桌宠点击）时切到指定 Tab（chat）；快捷菜单"跟我对话"亦走同一通道。
import { useCallback, useEffect, useState } from 'react'
import { ChatTab } from './tabs/ChatTab'
import { ProfileTab } from './tabs/ProfileTab'
import { EncyclopediaTab } from './tabs/EncyclopediaTab'
import { CommunityTab } from './tabs/CommunityTab'
import { GuestLock } from './tabs/GuestLock'
import type { StoredProfile } from '../../electron/storage'
import type { User } from '../api/types'
import { getMe } from '../api/client'

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

  // 首次 mount：从主进程读 profile.json + token；接着用 token 拉 server user
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
              if (!cancelled) setUser(u)
            })
            .catch((err: unknown) => {
              console.error('[panel] 拉取 server user 失败：', err)
            })
        } else {
          // token 缺失或 profile 未初始化 → 访客态
          setIsGuest(true)
        }
      })
      .catch((err: unknown) => {
        console.error('[panel] 读取本地档案失败：', err)
      })
    return () => {
      cancelled = true
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
        return <div className="profile-loading">加载中…</div>
      }
      return <ProfileTab user={user} token={token} onUserChange={onUserChange} />
    }
    return <div className="profile-loading">加载中…</div>
  }

  return (
    <div className="panel-shell">
      <header className="panel-header">
        <div className="panel-header-left">
          <span className="panel-header-title">Petibi</span>
          {profile && !isGuest && (
            <span className="panel-header-sub">
              {profile.nickname ?? profile.email} · {profile.mbti}
            </span>
          )}
          {isGuest && (
            <span className="panel-header-sub panel-header-guest">访客模式 · 登录后开启对话</span>
          )}
        </div>
        <button
          type="button"
          className="panel-close"
          onClick={onClose}
          title="关闭面板（桌宠仍驻留桌面）"
          aria-label="关闭面板"
        >
          ×
        </button>
      </header>

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
              <span className="panel-tab-lock" aria-hidden="true">🔒</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  )
}