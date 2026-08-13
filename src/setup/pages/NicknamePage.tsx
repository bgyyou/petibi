// 【文件说明】昵称输入页（PRD §3.2）：下一步进入"选人格 / 测试"。
// 简单本地校验：1-16 字符，允许中英文数字空格下划线；提交前 trim 一遍。
import { useState } from 'react'
import { useSetup } from '../state/setupStore'

// 昵称限制：1-16 字符，去掉首尾空格后非空
const NICK_RE = /^[一-龥\w ]{1,16}$/

export function NicknamePage(): JSX.Element {
  const { state, dispatch } = useSetup()
  const [nickname, setNickname] = useState(state.nickname)
  const trimmed = nickname.trim()
  const valid = NICK_RE.test(trimmed)

  function handleNext(): void {
    if (!valid) return
    dispatch({ type: 'SET_NICKNAME', nickname: trimmed })
    dispatch({ type: 'GO_PICK' })
  }

  return (
    <div className="setup-shell">
      <header className="setup-header">
        <h1 className="setup-title">先给你起个名字</h1>
        <p className="setup-subtitle">桌宠会这样叫你（1-16 字，可中英文）</p>
      </header>
      <div className="setup-body">
        <div className="field">
          <label htmlFor="nick">昵称</label>
          <input
            id="nick"
            type="text"
            placeholder="例如 小明 / Alex / 一颗柚子"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={16}
            autoFocus
          />
          {!valid && trimmed.length > 0 && (
            <div className="field-error">昵称只能是中英文 / 数字 / 空格 / 下划线，1-16 字</div>
          )}
        </div>
      </div>
      <footer className="setup-footer">
        <span style={{ fontSize: 12, color: '#8a8a86' }}>已登录：{state.email}</span>
        <button
          type="button"
          className="btn"
          onClick={handleNext}
          disabled={!valid}
        >
          下一步
        </button>
      </footer>
    </div>
  )
}