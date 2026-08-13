// 【文件说明】初始化流程的状态机：5 步顺序推进，每步之间通过 reducer 派发事件。
// 选型理由：流程边界明确、步骤少，用 useReducer + Context 比 zustand / Redux 更轻；
// 每一步产生的数据（token / 昵称 / 测试答案 / 结果）都集中在 store，避免 props drilling。
import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react'
import type { Answers, AnswerValue } from '../../scoring/types'
import type { TypeResult } from '../../scoring/types'

// 5 步：login → nickname → pick → test → result
export type SetupStep = 'login' | 'nickname' | 'pick' | 'test' | 'result'

// 整体状态
export interface SetupState {
  step: SetupStep
  // 登录后才有
  email: string
  token: string | null
  // 昵称
  nickname: string
  // 直接选择的 MBTI（pick 步骤），可能为空（说明走测试）
  pickedType: string | null
  // 测试过程中的答案与结果
  answers: Answers
  result: TypeResult | null
  // 提交反馈是否成功（结果页用）
  feedbackRecorded: boolean
}

const INITIAL: SetupState = {
  step: 'login',
  email: '',
  token: null,
  nickname: '',
  pickedType: null,
  answers: {},
  result: null,
  feedbackRecorded: false,
}

// 所有可能的 action（type-tagged union；TS 友好且 reducer 易维护）
export type SetupAction =
  | { type: 'LOGIN_SUCCESS'; email: string; token: string }
  | { type: 'GO_NICKNAME' }
  | { type: 'SET_NICKNAME'; nickname: string }
  | { type: 'GO_PICK' }
  | { type: 'PICK_TYPE'; mbti: string }
  | { type: 'GO_TEST' }
  | { type: 'ANSWER'; questionId: string; value: AnswerValue }
  | { type: 'GO_NEXT' }
  | { type: 'UNDO_LAST'; questionId: string }
  | { type: 'TEST_DONE'; result: TypeResult }
  | { type: 'GO_RESULT'; result: TypeResult }
  | { type: 'FEEDBACK_RECORDED' }
  | { type: 'BACK_TO_PICK' }

function reducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case 'LOGIN_SUCCESS':
      return { ...state, email: action.email, token: action.token, step: 'nickname' }
    case 'GO_NICKNAME':
      return { ...state, step: 'nickname' }
    case 'SET_NICKNAME':
      return { ...state, nickname: action.nickname }
    case 'GO_PICK':
      // 进入选择页时清掉残留的 pickedType，避免"重选人格"后还被旧值串改
      return { ...state, step: 'pick', pickedType: null }
    case 'PICK_TYPE':
      return { ...state, pickedType: action.mbti, step: 'result' }
    case 'GO_TEST':
      // 进入测试页时清掉 pickedType；测试结果会以 result 字段为准
      return { ...state, answers: {}, pickedType: null, step: 'test' }
    case 'ANSWER': {
      // 单题答案写回；React 不需要 immutable 整体替换，但 reducer 统一风格更稳
      return { ...state, answers: { ...state.answers, [action.questionId]: action.value } }
    }
    case 'GO_NEXT':
      // 跳到下一题：reducer 不存 idx，UI 用 Object.keys(answers).length 推导；
      // 此 action 仅作为"语义化事件"让 reducer 知晓状态推进（目前不修改 state）
      return state
    case 'UNDO_LAST': {
      // 撤销上一题的答案：从 answers 里删掉该题 id 的键
      const next: Answers = { ...state.answers }
      delete next[action.questionId]
      return { ...state, answers: next }
    }
    case 'TEST_DONE':
      return { ...state, result: action.result }
    case 'GO_RESULT':
      return { ...state, result: action.result, step: 'result' }
    case 'FEEDBACK_RECORDED':
      return { ...state, feedbackRecorded: true }
    case 'BACK_TO_PICK':
      return { ...state, step: 'pick' }
    default:
      return state
  }
}

interface Ctx {
  state: SetupState
  dispatch: Dispatch<SetupAction>
}

const SetupContext = createContext<Ctx | null>(null)

/** Provider：根组件用 */
export function SetupProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  // useMemo 防止 context 值每次重渲染都换引用，导致无关组件 rerender
  const value = useMemo(() => ({ state, dispatch }), [state])
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>
}

/** 子组件 hook：必须在 Provider 内部用 */
export function useSetup(): Ctx {
  const ctx = useContext(SetupContext)
  if (!ctx) {
    throw new Error('useSetup 必须在 <SetupProvider> 内部使用')
  }
  return ctx
}