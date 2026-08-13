// 【文件说明】主面板根组件：4 Tab 切换 + 头部状态栏 + 关闭按钮（隐藏面板）。
// 设计：
//   - 顶部：人格名 + 今日剩余次数 + 关闭按钮
//   - 中部：Tab 内容区（对话 / 百科 / 社区 / 我的）
//   - 对话 Tab + 我的 Tab 完整实现；百科 / 社区 显示"即将上线"占位
//   - 关闭按钮只 hide 面板（不退出 app），由主进程 IPC 完成
//   - 我的 Tab 需要 server user 状态 + token：从 init.token 拿 token，首次 mount 时 getMe 拉一次 user
import { useCallback, useEffect, useState } from 'react'
import { ChatTab } from './tabs/ChatTab'
import { ProfileTab } from './tabs/ProfileTab'
import { PlaceholderTab } from './tabs/PlaceholderTab'
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

export function App(): JSX.Element {
  // 当前激活的 Tab；外部触发（桌宠唤回）时重置为"对话"——保证用户点桌宠就看到对话
  const [activeTab, setActiveTab] = useState<TabId>('chat')
  // 本地 profile：用于头部展示昵称 / 人格；首次 mount 时通过 IPC 拉一次
  const [profile, setProfile] = useState<StoredProfile['profile']>(null)
  // server user：我的 Tab 需要展示宠物昵称 / 修改入口；首次 mount 时用 init.token 拉一次
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)

  // 首次 mount：从主进程读 profile.json + token；接着用 token 拉 server user
  useEffect(() => {
    let cancelled = false
    window.panelApi
      .getInit()
      .then((init) => {
        if (cancelled) return
        setProfile(init.profile)
        if (init.token) {
          setToken(init.token)
          // 拉 server user 拿宠物昵称 / mbti 等字段
          getMe(init.token)
            .then((u) => {
              if (!cancelled) setUser(u)
            })
            .catch((err: unknown) => {
              console.error('[panel] 拉取 server user 失败：', err)
            })
        }
      })
      .catch((err: unknown) => {
        console.error('[panel] 读取本地档案失败：', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 订阅外部唤回事件：把 Tab 重置到对话，UX 上"点桌宠就是来聊天的"
  useEffect(() => {
    window.panelApi.onPanelShown(() => {
      setActiveTab('chat')
    })
  }, [])

  /** 关闭按钮：通知主进程 hide panel，不退出 app */
  const onClose = useCallback((): void => {
    window.panelApi.hidePanel()
  }, [])

  /** 我的 Tab 修改昵称成功后回调：把新 user 合进本地状态 */
  const onUserChange = useCallback((next: User): void => {
    setUser(next)
  }, [])

  return (
    <div className="panel-shell">
      <header className="panel-header">
        <div className="panel-header-left">
          <span className="panel-header-title">Petibi</span>
          {profile && (
            <span className="panel-header-sub">
              {profile.nickname ?? profile.email} · {profile.mbti}
            </span>
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

      <main className="panel-body">
        {activeTab === 'chat' && <ChatTab />}
        {activeTab === 'baike' && (
          <PlaceholderTab
            title="MBTI 百科全书"
            description="按人格 × 场景 × 认知功能结构化收录的 400+ 条百科条目。即将上线。"
          />
        )}
        {activeTab === 'community' && (
          <PlaceholderTab
            title="社区广场"
            description="海报上墙 / 点赞 / 留言，机审保障内容安全。即将上线。"
          />
        )}
        {activeTab === 'profile' && user && token && (
          <ProfileTab user={user} token={token} onUserChange={onUserChange} />
        )}
        {activeTab === 'profile' && (!user || !token) && (
          <div className="profile-loading">加载中…</div>
        )}
      </main>

      <nav className="panel-tabs" aria-label="主面板 Tab 切换">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`panel-tab ${activeTab === t.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}