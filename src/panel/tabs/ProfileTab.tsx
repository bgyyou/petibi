// 【文件说明】「我的」Tab 升级版（M3 工单）：取代原 PlaceholderTab，显示用户档案 + 宠物昵称编辑入口。
//
// 行为契约（M3 工单）：
//   - 顶部：用户昵称 + MBTI + 动物（pet_name/animal）
//   - 宠物昵称区域：展示当前昵称（自定义或动物本名），右侧"修改"按钮
//   - 点击"修改"→ 弹出/唤起编辑器；调 POST /api/me/pet-nickname
//   - 冷却未到 → 展示剩余秒数（error.extra.remainSec），按钮置灰
//   - 成功后把 user 状态合并进父组件
//
// M4 扩展：常驻能力「重新测试人格」
//   - 顶部"用户信息"卡片右侧加「重新测试」按钮（位置显眼）；
//   - 点击 → 弹出像素风确认弹窗 → 用户确认 → 调 petApi.openSetupRetest()；
//   - 不需要 token / 鉴权（preload 直接走 IPC）；panel 不需要再处理 server 错误；
//   - 重测完成后主进程会广播 panel:profile-changed，父组件 App.tsx 已订阅 onProfileChanged
//     自动 refetch getMe，本组件的 user prop 自然更新。
//
// 复用 ChatTab 的设计风格：浅色纸感底 + 圆角卡片 + 暖色高亮，与 src/panel/styles.css 共享色板。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiCallError, getMe, setPetNickname } from '../../api/client'
import type { User } from '../../api/types'

/** 编辑器内部状态机：编辑中 / 提交中 / 冷却拒绝（带剩余秒数）
 *  - editing / saving 都携带 draft：保存中仍要把输入框里的字保留给用户看，
 *    且 Enter 触发时本地校验要拿当前 draft；不让 saving 模式丢失输入。
 */
type EditorState =
  | { mode: 'idle' }
  | { mode: 'editing'; draft: string }
  | { mode: 'saving'; draft: string }
  | { mode: 'cooldown'; remainSec: number; nextChangeAt: number }

interface ProfileTabProps {
  /** 父组件传入的当前用户；本地保存 nickname 编辑结果后通过 onUserChange 回告 */
  user: User
  /** 鉴权 token，refetch 与修改都靠它 */
  token: string
  /** 本地修改成功后回调，父组件把 user 合并进 header 与全局状态 */
  onUserChange: (next: User) => void
}

/** 把秒数格式化为「X 小时 Y 分」或「Y 分 Z 秒」，冷却倒计时显示用 */
function formatRemain(sec: number): string {
  if (sec <= 0) return '已可修改'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

/** 计算当前距 nextChangeAt 还差多少秒（不低于 0） */
function remainUntil(nextChangeAt: number, nowSec: number): number {
  return Math.max(0, nextChangeAt - nowSec)
}

/** 当前显示用的"宠物昵称"：自定义优先，未设时回退到动物本名 */
function displayPetNickname(user: User): string {
  if (user.pet_nickname && user.pet_nickname.length > 0) return user.pet_nickname
  return user.pet_name ?? '伙伴'
}

/** 副标题用人格标签：含动物（"INTJ · 猫头鹰"），mbti 未设时退化为邮箱 */
function subtitleFor(user: User): string {
  if (user.mbti) {
    const animal = user.animal ? ` · ${user.animal}` : ''
    return `${user.mbti}${animal}`
  }
  return user.email
}

export function ProfileTab({ user, token, onUserChange }: ProfileTabProps): ReactNode {
  // 编辑器状态机
  const [editor, setEditor] = useState<EditorState>({ mode: 'idle' })
  // 当前剩余秒数：60s 节流刷新一次，给倒计时"秒级"变化感
  const [nowTick, setNowTick] = useState<number>(Math.floor(Date.now() / 1000))
  // 全局错误条
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // M4 重测人格：确认弹窗开关
  const [retestConfirmOpen, setRetestConfirmOpen] = useState(false)

  // 1Hz tick：用于刷新倒计时显示
  useEffect(() => {
    const t = setInterval(() => {
      setNowTick(Math.floor(Date.now() / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // 当前是否在冷却中
  const remainSec = useMemo(
    () => remainUntil(user.next_change_at, nowTick),
    [user.next_change_at, nowTick],
  )
  const isCooling = user.pet_nickname_changed_at > 0 && remainSec > 0

  /**
   * M4 重测人格：点击「重新测试人格」按钮 → 打开确认弹窗。
   * 弹窗用像素风 + 墨色半透明遮罩（DESIGN.md §3），不复用浏览器原生 confirm。
   */
  const openRetestConfirm = useCallback((): void => {
    setErrorMsg(null)
    setRetestConfirmOpen(true)
  }, [])

  const closeRetestConfirm = useCallback((): void => {
    setRetestConfirmOpen(false)
  }, [])

  /**
   * M4 P2-025 登录门禁：退出登录。
   * - 通知主进程走 panel:logout：清 token + 隐藏桌宠 + 打开 setup 登录页；
   * - profile 字段由主进程保留（email/nickname/mbti/subtype/createdAt 不动），
   *   重新登录成功后由 LoginPage 老用户直通路径合并写回（避免 /api/me/profile 409）；
   * - 与 panel/App.tsx 的 setAuthInvalidHandler（401 触发）效果对齐，但这里由用户主动触发。
   */
  const onLogout = useCallback((): void => {
    setErrorMsg(null)
    const api = (window as unknown as { panelApi?: { logout?: () => void } }).panelApi
    if (!api || typeof api.logout !== 'function') {
      setErrorMsg('退出登录入口不可用，请重启应用')
      return
    }
    api.logout()
  }, [])

  /**
   * 退出登录确认弹窗开关：避免误触点「退出登录」导致 token 清掉需重输验证码。
   * 与 retest 复用同一套像素风遮罩样式（profile-retest-modal 系列）。
   */
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)

  const openLogoutConfirm = useCallback((): void => {
    setErrorMsg(null)
    setLogoutConfirmOpen(true)
  }, [])

  const closeLogoutConfirm = useCallback((): void => {
    setLogoutConfirmOpen(false)
  }, [])

  const confirmLogout = useCallback((): void => {
    setLogoutConfirmOpen(false)
    onLogout()
  }, [onLogout])

  /**
   * 用户在确认弹窗点「确认更换」→ 调主进程拉起 retest 模式 setup 窗。
   * 后续流程主进程负责：
   *   - 关 panel 窗 / 创建 setup 窗（?mode=retest&initialStep=pick）；
   *   - 用户走完选人格 / 测试后，notifyRetestComplete 写回 profile.json；
   *   - 主进程广播 panel:profile-changed，父组件 App.tsx 自动 refetch getMe。
   * 错误兜底：极端情况下 preload API 不可用（理论上不会发生），用 errorMsg 提示。
   */
  const confirmRetest = useCallback((): void => {
    setRetestConfirmOpen(false)
    const api = window.petApi
    if (!api || typeof api.openSetupRetest !== 'function') {
      setErrorMsg('重测入口不可用，请重启应用')
      return
    }
    api.openSetupRetest()
  }, [])

  /** 进入编辑态：以当前昵称（自定义或本名）为初值 */
  const startEdit = useCallback((): void => {
    setErrorMsg(null)
    setEditor({ mode: 'editing', draft: displayPetNickname(user) })
  }, [user])

  const cancelEdit = useCallback((): void => {
    setEditor({ mode: 'idle' })
    setErrorMsg(null)
  }, [])

  /** 提交修改：调 POST /api/me/pet-nickname，成功 → 合并 user + 退到 idle；冷却拒绝 → 进入 cooldown 态 */
  const submitEdit = useCallback(async (): Promise<void> => {
    if (editor.mode !== 'editing') return
    const draft = editor.draft
    setEditor({ mode: 'saving', draft })
    setErrorMsg(null)
    try {
      const res = await setPetNickname(token, { nickname: draft })
      // 成功：先合并本地 user（避免整页闪），同时再用 getMe 拉一遍确保 mbti/animal 字段也带回来
      onUserChange({
        ...user,
        pet_nickname: res.pet_nickname,
        pet_nickname_changed_at: res.pet_nickname_changed_at,
        next_change_at: res.next_change_at,
      })
      setEditor({ mode: 'idle' })
      try {
        const fresh = await getMe(token)
        onUserChange(fresh)
      } catch {
        /* 即使拉取失败，本地合并的 pet_nickname 也正确，不阻塞 UX */
      }
    } catch (err) {
      if (err instanceof ApiCallError && err.code === 'PET_NICKNAME_COOLDOWN') {
        // 冷却拒绝：拿剩余秒数展示倒计时，按钮置灰
        const extra = (err.extra ?? {}) as { remainSec?: number; nextChangeAt?: number }
        const remain = extra.remainSec ?? remainSec
        const nextChange = extra.nextChangeAt ?? user.next_change_at
        setEditor({ mode: 'cooldown', remainSec: remain, nextChangeAt: nextChange })
      } else {
        const msg = err instanceof ApiCallError ? err.message : '修改失败，请重试'
        setErrorMsg(msg)
        setEditor({ mode: 'editing', draft })
      }
    }
  }, [editor, token, user, remainSec, onUserChange])

  /**
   * 渲染编辑态下的 input：保存中时仍要展示原始 draft，所以 saving 分支单独处理。
   * 用独立函数抽离出 editor.mode 的联合类型收缩。
   */
  const editorDraft = (): string => {
    switch (editor.mode) {
      case 'editing':
        return editor.draft
      case 'saving':
        return editor.draft
      default:
        return ''
    }
  }

  /** 渲染：宠物昵称行（带修改入口 / 冷却倒计时） */
  const renderNicknameRow = (): ReactNode => {
    if (editor.mode === 'editing' || editor.mode === 'saving') {
      const saving = editor.mode === 'saving'
      return (
        <div className="profile-nickname-row is-editing">
          <input
            className="profile-nickname-input"
            type="text"
            value={editorDraft()}
            maxLength={16}
            disabled={saving}
            onChange={(e) => {
              if (!saving) setEditor({ mode: 'editing', draft: e.target.value })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitEdit()
              } else if (e.key === 'Escape') {
                cancelEdit()
              }
            }}
            placeholder="1-8 字，提交后 72 小时内不可再改"
            aria-label="宠物昵称"
          />
          <button
            type="button"
            className="profile-btn profile-btn-primary"
            disabled={saving}
            onClick={() => void submitEdit()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="profile-btn profile-btn-ghost"
            disabled={saving}
            onClick={cancelEdit}
          >
            取消
          </button>
        </div>
      )
    }
    return (
      <div className="profile-nickname-row">
        <div className="profile-nickname-value">
          <span className="profile-nickname-name">{displayPetNickname(user)}</span>
          {user.pet_nickname && user.pet_name && user.pet_nickname !== user.pet_name && (
            <span className="profile-nickname-origin">（动物本名：{user.pet_name}）</span>
          )}
        </div>
        <button
          type="button"
          className="profile-btn profile-btn-ghost"
          disabled={isCooling}
          onClick={startEdit}
          title={isCooling ? `冷却中，${formatRemain(remainSec)}后可改` : '修改宠物昵称'}
        >
          {isCooling ? `${formatRemain(remainSec)}后可改` : '修改'}
        </button>
      </div>
    )
  }

  return (
    <div className="profile-shell">
      <section className="profile-card" aria-label="用户信息">
        <div className="profile-card-header">
          <div className="profile-avatar" aria-hidden="true">
            {(user.nickname ?? user.email).slice(0, 1).toUpperCase()}
          </div>
          <div className="profile-card-titles">
            <div className="profile-name">{user.nickname ?? '未设置昵称'}</div>
            <div className="profile-sub">{subtitleFor(user)}</div>
          </div>
          {/* M4 重测人格：常驻入口，放头像右侧、显眼位置。
              风格与 .profile-btn-ghost 一致：纸白底 + 3px 墨边框 + 硬阴影。 */}
          <button
            type="button"
            className="profile-btn profile-btn-ghost profile-retest-btn"
            onClick={openRetestConfirm}
            title="重新测试人格"
          >
            重新测试人格
          </button>
        </div>
        <dl className="profile-meta">
          <div className="profile-meta-row">
            <dt>邮箱</dt>
            <dd>{user.email}</dd>
          </div>
          <div className="profile-meta-row">
            <dt>MBTI</dt>
            <dd>{user.mbti ?? '尚未完成测评'}</dd>
          </div>
          <div className="profile-meta-row">
            <dt>细分</dt>
            <dd>
              {user.subtype === 'stable'
                ? '稳定型（A）'
                : user.subtype === 'sensitive'
                  ? '敏感型（T）'
                  : '尚未完成测评'}
            </dd>
          </div>
          <div className="profile-meta-row">
            <dt>动物</dt>
            <dd>{user.animal ?? '尚未完成测评'}</dd>
          </div>
        </dl>
      </section>

      <section className="profile-card" aria-label="宠物昵称">
        <div className="profile-card-section-title">宠物昵称</div>
        <div className="profile-card-section-desc">
          {user.pet_nickname_changed_at > 0
            ? '修改后 72 小时内不能再次修改。'
            : '首次设置不受限。'}
        </div>
        {renderNicknameRow()}

        {editor.mode === 'cooldown' && (
          <div className="profile-cooldown-hint">
            冷却中，<strong>{formatRemain(editor.remainSec)}</strong>后可再次修改。
          </div>
        )}

        {errorMsg && <div className="profile-error-hint">{errorMsg}</div>}
      </section>

      <section className="profile-card profile-card-future" aria-label="未来功能">
        <div className="profile-card-section-title">即将上线</div>
        <ul className="profile-future-list">
          <li>人格细分报告</li>
          <li>分享解锁装扮</li>
          <li>历史对话回顾</li>
        </ul>
      </section>

      {/*
        M4 P2-025 登录门禁：「我的」Tab 加「退出登录」按钮。
        位置选择：放在未来功能卡片下方，独立成段（不污染既有卡片结构）；
        样式与 .profile-btn-ghost 一致（纸白底 + 3px 墨边框 + 硬阴影），点击 → 弹确认弹窗
        （避免误触），用户确认后再走 panel:logout 主进程链路。
        仅登录态显示——访客态没 token 也就没有"退出"的概念（panel App.tsx 已用 GuestLock 锁定此 Tab）。
      */}
      <section className="profile-card profile-card-logout" aria-label="退出登录">
        <div className="profile-card-section-title">账号</div>
        <div className="profile-card-section-desc">
          退出登录会清空本地登录态。桌宠将隐藏，宠物档案保留；下次打开可重新登录或继续以访客身份浏览。
        </div>
        <button
          type="button"
          className="profile-btn profile-btn-ghost profile-logout-btn"
          onClick={openLogoutConfirm}
          title="退出登录"
        >
          退出登录
        </button>
      </section>

      {/* M4 重测人格：像素风确认弹窗（DESIGN.md §3：纸白底 + 3px 墨边框 + 4px 硬阴影 + 墨色半透明遮罩）。
          用 React 状态控制而不是 window.confirm —— 后者样式与游戏化设计脱节。 */}
      {retestConfirmOpen && (
        <div
          className="poster-modal-backdrop"
          role="presentation"
          onClick={closeRetestConfirm}
        >
          <div
            className="profile-retest-modal"
            role="dialog"
            aria-modal="true"
            aria-label="确认重新测试人格"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="profile-retest-modal-header">
              <div className="poster-modal-title">重新测试人格</div>
              <button
                type="button"
                className="poster-modal-close"
                aria-label="关闭"
                onClick={closeRetestConfirm}
              >
                ×
              </button>
            </div>
            <div className="profile-retest-modal-body">
              <p className="profile-retest-modal-desc">
                重新测试会覆盖当前人格结果，桌宠形象会更换。
                <br />
                当前：<strong>{user.mbti ?? '未测'}</strong>
                {user.subtype === 'stable'
                  ? '（稳定型）'
                  : user.subtype === 'sensitive'
                    ? '（敏感型）'
                    : ''}
              </p>
              <p className="profile-retest-modal-hint">
                完成后无需重启，桌宠会立刻换上新形象。
              </p>
            </div>
            <div className="profile-retest-modal-footer">
              <button
                type="button"
                className="profile-btn profile-btn-ghost"
                onClick={closeRetestConfirm}
              >
                再想想
              </button>
              <button
                type="button"
                className="profile-btn profile-btn-primary"
                onClick={confirmRetest}
              >
                确认更换
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        M4 P2-025 登录门禁：退出登录确认弹窗（复用 retest 弹窗的像素风样式）。
        文案强调「桌宠将隐藏」以避免用户预期落差（ISSUES P2-025 owner 原话）。
      */}
      {logoutConfirmOpen && (
        <div
          className="poster-modal-backdrop"
          role="presentation"
          onClick={closeLogoutConfirm}
        >
          <div
            className="profile-retest-modal"
            role="dialog"
            aria-modal="true"
            aria-label="确认退出登录"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="profile-retest-modal-header">
              <div className="poster-modal-title">退出登录</div>
              <button
                type="button"
                className="poster-modal-close"
                aria-label="关闭"
                onClick={closeLogoutConfirm}
              >
                ×
              </button>
            </div>
            <div className="profile-retest-modal-body">
              <p className="profile-retest-modal-desc">
                退出登录后，桌宠将隐藏；本地宠物档案（昵称 / 人格）会保留。
                <br />
                当前账号：<strong>{user.email}</strong>
              </p>
              <p className="profile-retest-modal-hint">
                重新打开应用时需要重新验证邮箱登录。
              </p>
            </div>
            <div className="profile-retest-modal-footer">
              <button
                type="button"
                className="profile-btn profile-btn-ghost"
                onClick={closeLogoutConfirm}
              >
                再想想
              </button>
              <button
                type="button"
                className="profile-btn profile-btn-primary"
                onClick={confirmLogout}
              >
                确认退出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}