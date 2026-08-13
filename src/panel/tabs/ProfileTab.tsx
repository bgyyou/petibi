// 【文件说明】「我的」Tab 升级版（M3 工单）：取代原 PlaceholderTab，显示用户档案 + 宠物昵称编辑入口。
//
// 行为契约（M3 工单）：
//   - 顶部：用户昵称 + MBTI + 动物（pet_name/animal）
//   - 宠物昵称区域：展示当前昵称（自定义或动物本名），右侧"修改"按钮
//   - 点击"修改"→ 弹出/唤起编辑器；调 POST /api/me/pet-nickname
//   - 冷却未到 → 展示剩余秒数（error.extra.remainSec），按钮置灰
//   - 成功后把 user 状态合并进父组件
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
    </div>
  )
}