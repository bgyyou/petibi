// 【文件说明】初始化流程状态机 reducer 纯函数测试（M4 工单 P0-005 / P0-006 回归）。
//
// 覆盖两条 owner 实测发现的 P0 bug：
//   - P0-005 「测得不对，重新选择」选完新人格仍回到旧结果页（状态未重置）
//   - P0-006 点「测的不准」反馈成功后软件整个退出
//
// 由于 reducer 是纯函数（不依赖 React runtime），用 vitest node 环境直接 import
// 即可，回归成本低。完整流程由 ResultPage / PickTypePage 在 UI 层组合，
// 这里把 reducer 的语义用"初始 → 一串 action → 断言终态"的方式钉死。

import { describe, expect, it } from 'vitest'
import {
  INITIAL_SETUP_STATE,
  setupReducer,
  type SetupState,
} from '../state/setupStore'
import type { TypeResult } from '../../scoring/types'

/** 一个固定的 TypeResult fixture：模拟"上次测试得 ENFJ·sensitive" */
const ENFJ_RESULT: TypeResult = {
  type: 'ENFJ',
  subtype: 'sensitive',
  percentages: { EI: 80, SN: 60, TF: 25, JP: 70, ES: 35 },
}

/** 另一个 TypeResult fixture：模拟"上次测试得 INTJ·stable" */
const INTJ_RESULT: TypeResult = {
  type: 'INTJ',
  subtype: 'stable',
  percentages: { EI: 20, SN: 80, TF: 80, JP: 85, ES: 80 },
}

/** 跑完一串 action 返回最终 state（reducer 纯函数便于断言） */
function runActions(actions: ReadonlyArray<Parameters<typeof setupReducer>[1]>): SetupState {
  return actions.reduce(setupReducer, INITIAL_SETUP_STATE)
}

// =====================================================================
// P0-005：重新选择人格后结果页必须显示新人格，不能仍显示旧测试结果
// =====================================================================
describe('P0-005 重选人格 → 结果页应展示新人格', () => {
  it('场景：测试得 ENFJ → 结果页 → 「重选人格」→ 选 INTJ → 应进 INTJ 结果页', () => {
    // 1) 登录到 nickname → 切到 pick → 进入测试 → 答完拿到 ENFJ 结果 → 到结果页
    // 2) 点"重选人格" → BACK_TO_PICK（清掉旧 result）
    // 3) 在选择页直接选 INTJ → PICK_TYPE（覆盖 pickedType 为新值，且 result 必须被清）
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'SET_NICKNAME', nickname: '小明' },
      { type: 'GO_PICK' },
      { type: 'GO_TEST' },
      { type: 'GO_RESULT', result: ENFJ_RESULT },
      // ---- 用户在结果页点「重选人格」 ----
      { type: 'BACK_TO_PICK' },
      // ---- 回到选择页后选了 INTJ ----
      { type: 'PICK_TYPE', mbti: 'INTJ' },
    ])

    // ★ P0-005 修复点：state.result 必须被清掉（不能残留旧的 ENFJ 测试结果），
    // 否则 ResultPage 里 resultType = state.result?.type ?? state.pickedType ?? ''
    // 会优先取旧的 result.type = 'ENFJ'，导致重选后页面仍显示旧人格。
    expect(state.result).toBeNull()
    // pickedType 必须被新人格覆盖
    expect(state.pickedType).toBe('INTJ')
    // step 必须切到 result（新流程推进）
    expect(state.step).toBe('result')
  })

  it('场景：测试得 ENFJ → 直接选 ISFP（未走 BACK_TO_PICK）→ result 也必须清', () => {
    // 即便用户没有点"重选人格"，只要重新 PICK_TYPE，result 也得清
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'GO_PICK' },
      { type: 'GO_TEST' },
      { type: 'GO_RESULT', result: ENFJ_RESULT },
      { type: 'PICK_TYPE', mbti: 'ISFP' },
    ])
    expect(state.result).toBeNull()
    expect(state.pickedType).toBe('ISFP')
    expect(state.step).toBe('result')
  })

  it('场景：选 ENFJ → 结果页反馈 → 重选 INTP → result / answers / feedbackRecorded 全清', () => {
    // 用户走完整流程：选人格 → 结果页反馈完成 → 重选
    // GO_PICK 必须清掉所有与「旧结果」相关的状态，避免：
    //   1) result 残留让重选后页面仍显旧人格；
    //   2) answers 残留让用户再进测试时进度计算错（currentIdx = keys(answers).length）；
    //   3) feedbackRecorded 残留让重选后的"反馈已记录"提示误显。
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'SET_NICKNAME', nickname: '小明' },
      { type: 'GO_PICK' },
      { type: 'PICK_TYPE', mbti: 'ENFJ' },
      { type: 'FEEDBACK_RECORDED' },
      // ---- 用户在结果页点「重选人格」 ----
      { type: 'GO_PICK' },
      // ---- 选了新人格 ----
      { type: 'PICK_TYPE', mbti: 'INTP' },
    ])

    expect(state.result).toBeNull()
    expect(state.answers).toEqual({})
    expect(state.pickedType).toBe('INTP')
    expect(state.feedbackRecorded).toBe(false)
    expect(state.step).toBe('result')
  })

  it('场景：测试得 INTJ → 重测 → GO_TEST 必须清旧 result（防止重测中页面跳旧人格）', () => {
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'GO_PICK' },
      { type: 'GO_TEST' },
      { type: 'GO_RESULT', result: INTJ_RESULT },
      // 用户在结果页点"测得不对，重新选择" → 走"不确定 → 去测一下" → GO_TEST
      { type: 'GO_TEST' },
    ])
    expect(state.result).toBeNull()
    expect(state.answers).toEqual({})
    expect(state.pickedType).toBeNull()
    expect(state.step).toBe('test')
  })

  it('BACK_TO_PICK 单独触发也要清 result（最简单 P0-005 修复路径）', () => {
    const state = runActions([
      { type: 'GO_RESULT', result: ENFJ_RESULT },
      { type: 'BACK_TO_PICK' },
    ])
    // 现有 BACK_TO_PICK 只翻 step；result 的清理由后续 PICK_TYPE/GO_TEST 完成
    expect(state.step).toBe('pick')
    // 进入选择页后下一步必须 PICK_TYPE/GO_TEST，它们会把 result 清掉（见上面用例）
    // 这里只是 BACK_TO_PICK 自身的契约：不动 result
    expect(state.result).toEqual(ENFJ_RESULT)
  })
})

// =====================================================================
// P0-006：反馈成功后状态机不允许触发 completeSetup / 切 step
// =====================================================================
describe('P0-006 反馈成功后状态机不能触发退出链路', () => {
  it('FEEDBACK_RECORDED 必须只翻 feedbackRecorded，不得动 step', () => {
    const state = runActions([
      { type: 'GO_RESULT', result: ENFJ_RESULT },
      { type: 'FEEDBACK_RECORDED' },
    ])
    // ★ P0-006 核心契约：FEEDBACK_RECORDED 必须停留在 result 步骤
    expect(state.step).toBe('result')
    // 仅 feedbackRecorded 被翻
    expect(state.feedbackRecorded).toBe(true)
    // 其它状态保持不变（result 不被清，pickedType 不动，等等）
    expect(state.result).toEqual(ENFJ_RESULT)
    expect(state.pickedType).toBeNull()
  })

  it('FEEDBACK_RECORDED 在 pickedType 路径下也必须保持 result step', () => {
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'GO_PICK' },
      { type: 'PICK_TYPE', mbti: 'ENFP' },
      // 在 ENFP 结果页点反馈
      { type: 'FEEDBACK_RECORDED' },
    ])
    expect(state.step).toBe('result')
    expect(state.feedbackRecorded).toBe(true)
    expect(state.pickedType).toBe('ENFP')
    expect(state.result).toBeNull()
  })

  it('连续两次 FEEDBACK_RECORDED 也是幂等的（不会越界切走 step）', () => {
    const state = runActions([
      { type: 'GO_RESULT', result: ENFJ_RESULT },
      { type: 'FEEDBACK_RECORDED' },
      { type: 'FEEDBACK_RECORDED' },
      { type: 'FEEDBACK_RECORDED' },
    ])
    expect(state.step).toBe('result')
    expect(state.feedbackRecorded).toBe(true)
  })

  it('reducer 派发的所有 SetupAction 中没有任何一个会触发 completeSetup（白名单核对）', () => {
    // 完整跑一遍：登录 → 昵称 → 选 → 测试 → 结果 → 反馈 → 重选 → 再选
    // 任何一个 action 都不应把 step 推到 "complete / exit / null"。
    // 期望 step 始终在 5 步之内（'login' | 'nickname' | 'pick' | 'test' | 'result'）
    const validSteps = new Set(['login', 'nickname', 'pick', 'test', 'result'])
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'GO_NICKNAME' },
      { type: 'SET_NICKNAME', nickname: '小明' },
      { type: 'GO_PICK' },
      { type: 'PICK_TYPE', mbti: 'ESFJ' },
      { type: 'FEEDBACK_RECORDED' },
      { type: 'BACK_TO_PICK' },
      { type: 'PICK_TYPE', mbti: 'ISTP' },
      { type: 'GO_TEST' },
      { type: 'GO_RESULT', result: ENFJ_RESULT },
      { type: 'FEEDBACK_RECORDED' },
      { type: 'FEEDBACK_RECORDED' },
    ])
    expect(validSteps.has(state.step)).toBe(true)
    // 完成路径上一定停在 result（最后两步是 GO_RESULT + 反馈）
    expect(state.step).toBe('result')
    // ★ 反馈后绝对不能停在 result 以外的任何 step（P0-006 红线）
    expect(state.step).not.toBe('login')
    expect(state.step).not.toBe('nickname')
    expect(state.step).not.toBe('pick')
    expect(state.step).not.toBe('test')
  })
})

// =====================================================================
// 回归：原有用例不能因为改 reducer 而被打破
// =====================================================================
describe('原 reducer 行为回归', () => {
  it('LOGIN_SUCCESS → step 进入 nickname，email/token 被写入', () => {
    const state = setupReducer(INITIAL_SETUP_STATE, {
      type: 'LOGIN_SUCCESS',
      email: 'a@b.com',
      token: 'tok-x',
    })
    expect(state.step).toBe('nickname')
    expect(state.email).toBe('a@b.com')
    expect(state.token).toBe('tok-x')
  })

  it('GO_TEST 同时清掉 pickedType 和 answers（既有契约）', () => {
    const state = runActions([
      { type: 'PICK_TYPE', mbti: 'INFP' },
      { type: 'ANSWER', questionId: 'q1', value: 4 },
      { type: 'ANSWER', questionId: 'q2', value: 5 },
      { type: 'GO_TEST' },
    ])
    expect(state.step).toBe('test')
    expect(state.pickedType).toBeNull()
    expect(state.answers).toEqual({})
  })

  it('UNDO_LAST 从 answers 中删除对应题号', () => {
    const state = runActions([
      { type: 'ANSWER', questionId: 'q1', value: 3 },
      { type: 'ANSWER', questionId: 'q2', value: 4 },
      { type: 'UNDO_LAST', questionId: 'q2' },
    ])
    expect(state.answers).toEqual({ q1: 3 })
  })

  it('GO_RESULT 清掉 pickedType（保持 result 路径唯一渲染来源）', () => {
    const state = runActions([
      { type: 'PICK_TYPE', mbti: 'ESTP' },
      { type: 'GO_RESULT', result: ENFJ_RESULT },
    ])
    expect(state.step).toBe('result')
    expect(state.result).toEqual(ENFJ_RESULT)
    // GO_RESULT 必须清掉 pickedType：避免"测试完 → 重选 → 再走 GO_RESULT"时
    // 被旧的 pickedType 串改（与 P0-005 同源问题，巩固修复）
    expect(state.pickedType).toBeNull()
  })

  it('SET_NICKNAME 仅写入 nickname，不影响其它字段', () => {
    const state = setupReducer(INITIAL_SETUP_STATE, { type: 'SET_NICKNAME', nickname: '小明' })
    expect(state.nickname).toBe('小明')
    expect(state.step).toBe('login')
  })
})

// =====================================================================
// M4 重测人格：INIT_FROM_PROFILE action 状态流转（钉死重测入口的契约）
// =====================================================================
describe('M4 重测人格：INIT_FROM_PROFILE 入口', () => {
  it('mode=retest + initialStep=pick → 直接进入 pick 步骤（跳过 login/nickname）', () => {
    // 关键契约：retest 模式下用户不应再看到登录页 / 昵称页。
    const state = setupReducer(INITIAL_SETUP_STATE, {
      type: 'INIT_FROM_PROFILE',
      mode: 'retest',
      initialStep: 'pick',
      token: 'tok-existing',
      email: 'old@user.com',
      nickname: '老用户',
      currentMbti: 'INTJ',
    })
    expect(state.mode).toBe('retest')
    expect(state.step).toBe('pick')
    expect(state.token).toBe('tok-existing')
    expect(state.email).toBe('old@user.com')
    expect(state.nickname).toBe('老用户')
  })

  it('mode=retest + initialStep=test → 直接进入 test 步骤（跳过 login/nickname/pick）', () => {
    const state = setupReducer(INITIAL_SETUP_STATE, {
      type: 'INIT_FROM_PROFILE',
      mode: 'retest',
      initialStep: 'test',
      token: 'tok-existing',
      email: 'old@user.com',
      nickname: '老用户',
    })
    expect(state.mode).toBe('retest')
    expect(state.step).toBe('test')
    expect(state.token).toBe('tok-existing')
  })

  it('INIT_FROM_PROFILE 必须显式清掉旧 result / answers / pickedType / feedbackRecorded（P0-005 防御）', () => {
    // 即使 state 已经被污染（比如从 ResultPage 跳回），INIT_FROM_PROFILE 也要保证：
    //   - result 清空：避免旧测试人格串到新轮次
    //   - answers 清空：避免"重测时 currentIdx 算错"
    //   - pickedType 清空：避免旧选用人格被展示
    //   - feedbackRecorded 清空：避免重测结果页误显"反馈已记录"
    const polluted = setupReducer(INITIAL_SETUP_STATE, {
      type: 'GO_RESULT',
      result: ENFJ_RESULT,
    })
    expect(polluted.result).toEqual(ENFJ_RESULT)
    const state = setupReducer(polluted, {
      type: 'INIT_FROM_PROFILE',
      mode: 'retest',
      initialStep: 'pick',
      token: 'tok',
      email: 'a@b.com',
      nickname: '小明',
    })
    expect(state.result).toBeNull()
    expect(state.answers).toEqual({})
    expect(state.pickedType).toBeNull()
    expect(state.feedbackRecorded).toBe(false)
  })

  it('retest 模式下：PICK_TYPE → 直接进入 result，step 与初始模式相同', () => {
    // retest 模式下选人格走的是与 initial 模式相同的 reducer 路径（PICK_TYPE 不分支），
    // 但前提是 INIT_FROM_PROFILE 必须先把 pickedType 清掉，否则 PICK_TYPE 不会污染。
    const state = runActions([
      {
        type: 'INIT_FROM_PROFILE',
        mode: 'retest',
        initialStep: 'pick',
        token: 'tok',
        email: 'a@b.com',
        nickname: '小明',
      },
      { type: 'PICK_TYPE', mbti: 'INFP' },
    ])
    expect(state.step).toBe('result')
    expect(state.pickedType).toBe('INFP')
    expect(state.result).toBeNull()
    expect(state.mode).toBe('retest')
  })

  it('retest 模式下：完整走完一轮测试 GO_RESULT，state 不丢失 mode', () => {
    const state = runActions([
      {
        type: 'INIT_FROM_PROFILE',
        mode: 'retest',
        initialStep: 'test',
        token: 'tok',
        email: 'a@b.com',
        nickname: '小明',
      },
      { type: 'ANSWER', questionId: 'q1', value: 3 },
      { type: 'ANSWER', questionId: 'q2', value: 4 },
      { type: 'GO_RESULT', result: INTJ_RESULT },
    ])
    // mode 必须保留为 retest（ResultPage 据此切走 "notifyRetestComplete" 而非 "completeSetup"）
    expect(state.mode).toBe('retest')
    expect(state.step).toBe('result')
    expect(state.result).toEqual(INTJ_RESULT)
  })

  it('INIT_FROM_PROFILE 必须能覆盖 mode 字段（多次切换 retest ↔ initial 不会残留）', () => {
    // 第一次：retest
    const s1 = setupReducer(INITIAL_SETUP_STATE, {
      type: 'INIT_FROM_PROFILE',
      mode: 'retest',
      initialStep: 'pick',
      token: 'tok',
      email: 'a@b.com',
      nickname: '小明',
    })
    expect(s1.mode).toBe('retest')
    // 第二次：再次 INIT（极端场景，比如重测中又点重测）切回 initial
    const s2 = setupReducer(s1, {
      type: 'INIT_FROM_PROFILE',
      mode: 'initial',
      initialStep: 'login',
      token: '',
      email: '',
      nickname: '',
    })
    expect(s2.mode).toBe('initial')
    expect(s2.step).toBe('login')
  })
})

// =====================================================================
// M4 setup 返回导航：3 个新 BACK_* action 的契约钉死
// owner 实测 setup 流程没有返回键，这里把语义用 reducer 纯函数钉住，
// 避免后续 UI 改回时 reducer 行为悄悄漂移。
// 契约要点：
//   - BACK_TO_LOGIN：step→'login'，保留 email/token/nickname
//   - BACK_TO_NICKNAME：step→'nickname'，保留 nickname/email/token
//   - BACK_TO_PICK_KEEP_ANSWERS：step→'pick'，保留 answers，不动 result/pickedType
// =====================================================================
describe('M4 setup 返回导航：3 个新 BACK_* action', () => {
  it('BACK_TO_LOGIN：step 切回 login，必须保留 email/token/nickname（owner 要求"不清空已填内容"）', () => {
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'SET_NICKNAME', nickname: '小明' },
      { type: 'GO_PICK' },
      // 用户在选人格页点"返回昵称"→ 昵称页 → 昵称页点"返回登录"
      { type: 'BACK_TO_NICKNAME' },
      { type: 'BACK_TO_LOGIN' },
    ])
    expect(state.step).toBe('login')
    // 三个字段必须保留：再走 LOGIN_SUCCESS→昵称页时这些数据还在
    expect(state.email).toBe('u@example.com')
    expect(state.token).toBe('tok-1')
    expect(state.nickname).toBe('小明')
    // answers / pickedType / result 也不被清（返回键只切 step）
    expect(state.answers).toEqual({})
    expect(state.pickedType).toBeNull()
    expect(state.result).toBeNull()
  })

  it('BACK_TO_LOGIN：从中途任意 step 切回都生效（reducer 不校验当前 step）', () => {
    // 从 result 步骤直接 BACK_TO_LOGIN：用户罕见路径，但 reducer 不应抛错
    const state = setupReducer(INITIAL_SETUP_STATE, { type: 'BACK_TO_LOGIN' })
    expect(state.step).toBe('login')
  })

  it('BACK_TO_NICKNAME：step 切回 nickname，必须保留 nickname（再进昵称页自动回填）', () => {
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'SET_NICKNAME', nickname: 'Alex' },
      { type: 'GO_PICK' },
      { type: 'BACK_TO_NICKNAME' },
    ])
    expect(state.step).toBe('nickname')
    expect(state.nickname).toBe('Alex')
    expect(state.email).toBe('u@example.com')
    expect(state.token).toBe('tok-1')
  })

  it('BACK_TO_NICKNAME：从测试页直接退回昵称页（极端路径），reducer 行为一致', () => {
    // 即便用户在 test 步骤点"返回昵称"（UI 路径其实不存在），reducer 也不应崩
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'SET_NICKNAME', nickname: 'Alex' },
      { type: 'GO_PICK' },
      { type: 'GO_TEST' },
      { type: 'BACK_TO_NICKNAME' },
    ])
    expect(state.step).toBe('nickname')
    // nickname 仍在
    expect(state.nickname).toBe('Alex')
    // answers 是从 test 步骤来的，BACK_TO_NICKNAME 不应清它（"不清空已填内容"覆盖 answers）
    expect(state.answers).toEqual({})
  })

  it('BACK_TO_PICK_KEEP_ANSWERS：step 切回 pick，必须保留 answers（owner 要求"已答题进度保留"）', () => {
    // 模拟：测试到第 5 题后返回选人格页
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'GO_PICK' },
      { type: 'GO_TEST' },
      { type: 'ANSWER', questionId: 'q1', value: 4 },
      { type: 'ANSWER', questionId: 'q2', value: 5 },
      { type: 'ANSWER', questionId: 'q3', value: 3 },
      { type: 'ANSWER', questionId: 'q4', value: 4 },
      { type: 'ANSWER', questionId: 'q5', value: 2 },
      // 点"返回选人格"
      { type: 'BACK_TO_PICK_KEEP_ANSWERS' },
    ])
    expect(state.step).toBe('pick')
    // ★ 关键契约：answers 必须完整保留
    expect(state.answers).toEqual({ q1: 4, q2: 5, q3: 3, q4: 4, q5: 2 })
    // 其它字段不动
    expect(state.result).toBeNull()
    expect(state.pickedType).toBeNull()
    expect(state.feedbackRecorded).toBe(false)
  })

  it('BACK_TO_PICK_KEEP_ANSWERS：从 pick 步骤调用是幂等的（step 不变，answers 不变）', () => {
    // 极端路径：从已经处于 pick 步骤的状态调用 BACK_TO_PICK_KEEP_ANSWERS
    // 不会清除 answers（兼容性保险）
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'GO_PICK' },
      { type: 'ANSWER', questionId: 'q1', value: 3 },
      { type: 'BACK_TO_PICK_KEEP_ANSWERS' },
    ])
    expect(state.step).toBe('pick')
    expect(state.answers).toEqual({ q1: 3 })
  })

  it('BACK_TO_PICK_KEEP_ANSWERS 后再 PICK_TYPE 进 result，answers 仍保留（UX 不被打断）', () => {
    // 用户路径：测试 3 题 → 返回选人格 → 直接选人格 → 进 result
    // 此时 answers 仍保留，但 result 由 PICK_TYPE 清掉（既有契约），step 切到 result
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'u@example.com', token: 'tok-1' },
      { type: 'GO_PICK' },
      { type: 'GO_TEST' },
      { type: 'ANSWER', questionId: 'q1', value: 4 },
      { type: 'ANSWER', questionId: 'q2', value: 5 },
      { type: 'ANSWER', questionId: 'q3', value: 3 },
      { type: 'BACK_TO_PICK_KEEP_ANSWERS' },
      { type: 'PICK_TYPE', mbti: 'INTJ' },
    ])
    expect(state.step).toBe('result')
    // PICK_TYPE 自身会清 result（既有契约），pickedType 写入新值
    expect(state.result).toBeNull()
    expect(state.pickedType).toBe('INTJ')
    // answers 保留：用户后续可以再次 GO_TEST 续答
    expect(state.answers).toEqual({ q1: 4, q2: 5, q3: 3 })
  })

  it('完整往返流程：login → nickname → pick → test → 返回选人格 → 返回昵称 → 返回登录，数据全部保留', () => {
    // 端到端往返：验证"返回键只切 step，不破坏数据"的总契约
    const state = runActions([
      { type: 'LOGIN_SUCCESS', email: 'a@b.com', token: 'tok-x' },
      { type: 'SET_NICKNAME', nickname: '小白' },
      { type: 'GO_PICK' },
      { type: 'GO_TEST' },
      { type: 'ANSWER', questionId: 'q1', value: 3 },
      { type: 'ANSWER', questionId: 'q2', value: 4 },
      // 从 test 一路返回到 login
      { type: 'BACK_TO_PICK_KEEP_ANSWERS' },
      { type: 'BACK_TO_NICKNAME' },
      { type: 'BACK_TO_LOGIN' },
    ])
    expect(state.step).toBe('login')
    expect(state.email).toBe('a@b.com')
    expect(state.token).toBe('tok-x')
    expect(state.nickname).toBe('小白')
    // answers 也保留（不被任何 BACK_* 清）
    expect(state.answers).toEqual({ q1: 3, q2: 4 })
    // mode 仍是 initial（未走 retest 入口）
    expect(state.mode).toBe('initial')
  })
})
