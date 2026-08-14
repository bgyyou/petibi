// 【文件说明】初始化流程的状态机：5 步顺序推进，每步之间通过 reducer 派发事件。
// 选型理由：流程边界明确、步骤少，用 useReducer + Context 比 zustand / Redux 更轻；
// 每一步产生的数据（token / 昵称 / 测试答案 / 结果）都集中在 store，避免 props drilling。
//
// M4 重测人格：state 新增 mode 字段（'initial' | 'retest'）+ INIT_FROM_PROFILE action。
//   - mode='initial'（默认）：从 login 走完整流程；
//   - mode='retest'：从 pick 直接进入（用户已有 token / 昵称 / 档案，重测只换人格）。
// 渲染进程 App.tsx 根据 URL ?mode=...&initialStep=... 调用 INIT_FROM_PROFILE 初始化。
// retest 模式下 ResultPage.handleComplete 走"通知主进程写回 + 关窗"，不走 completeSetup。
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

// 流程模式：M4 新增。
//   - 'initial'：首次注册 / 访客→登录走完整 5 步；
//   - 'retest'：从已登录态进入，跳过 login / nickname，从 pick 起步。
export type SetupMode = 'initial' | 'retest'

// 整体状态
export interface SetupState {
  /** 流程模式（M4 重测扩展）；retest 模式下跳过 login / nickname 步骤 */
  mode: SetupMode
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
  // M4 setup 返回导航：补充 BACK_TO_LOGIN / BACK_TO_NICKNAME / BACK_TO_PICK_KEEP_ANSWERS
  // 解决 owner 实测"setup 流程没有返回键"问题；语义细节见 reducer 分支注释。
  | { type: 'BACK_TO_LOGIN' }
  | { type: 'BACK_TO_NICKNAME' }
  | { type: 'BACK_TO_PICK_KEEP_ANSWERS' }
  // M4 重测人格：从主进程拉的本地档案初始化 state，跳过 login/nickname。
  // 渲染进程 App.tsx 读 URL ?mode=retest 后 dispatch 此 action。
  | {
      type: 'INIT_FROM_PROFILE'
      mode: SetupMode
      initialStep: SetupStep
      token: string
      email: string
      nickname: string
      /** 主进程读出的当前 mbti（用于 picker 高亮 / 测试预填提示，可选） */
      currentMbti?: string
    }

/** 初始状态（导出供测试 + 复位使用） */
export const INITIAL_SETUP_STATE: SetupState = {
  mode: 'initial',
  step: 'login',
  email: '',
  token: null,
  nickname: '',
  pickedType: null,
  answers: {},
  result: null,
  feedbackRecorded: false,
}

// reducer 改为命名导出，方便 vitest 在 node 环境下做纯函数状态机测试
// （不需要拉 React runtime）。原 reducer 是默认导出的位置不变。
export function setupReducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case 'INIT_FROM_PROFILE':
      // M4 重测人格：从主进程拉的本地档案初始化 state。
      //   - mode='initial'：通常与登录态同步进入；这里仍按 login 起步，保留旧行为；
      //   - mode='retest'：从 initialStep 直接进入（通常 'pick'），跳过 login / nickname。
      // 当前 mbti 在 retest 模式下不写到 result（避免"重选人格"被旧 result 串改 P0-005），
      // 由 ResultPage 自取（state.pickedType 为空时显示当前 mbti 提示用）。
      return {
        ...state,
        mode: action.mode,
        step: action.initialStep,
        token: action.token,
        email: action.email,
        nickname: action.nickname,
        // 进入 retest 时显式清掉旧 result / answers / pickedType / feedbackRecorded
        // （P0-005 同源防御：避免上一轮的人格状态影响新一轮选择）
        result: null,
        answers: {},
        pickedType: null,
        feedbackRecorded: false,
      }
    case 'LOGIN_SUCCESS':
      return { ...state, email: action.email, token: action.token, step: 'nickname' }
    case 'GO_NICKNAME':
      return { ...state, step: 'nickname' }
    case 'SET_NICKNAME':
      return { ...state, nickname: action.nickname }
    case 'GO_PICK':
      // 进入选择页时清掉所有与「旧结果」相关的状态：
      //   - pickedType：避免上一轮直接选用的人格再次被 reducer 串改；
      //   - result / answers：避免"重选人格"后结果页还显示旧测试结果（ISSUES P0-005）；
      //   - feedbackRecorded：与上一轮反馈解绑，避免误显"反馈已记录"。
      return {
        ...state,
        step: 'pick',
        pickedType: null,
        result: null,
        answers: {},
        feedbackRecorded: false,
      }
    case 'PICK_TYPE':
      // 直接选用新人格：必须把 result 清掉，否则 ResultPage 里
      //   resultType = state.result?.type ?? state.pickedType ?? ''
      // 会优先取旧的 result.type，重选后页面仍显示旧测试人格（P0-005）。
      return { ...state, pickedType: action.mbti, result: null, step: 'result' }
    case 'GO_TEST':
      // 重新进入测试页：清掉旧 result（避免重测完前结果页就显旧人格）、
      // 清掉旧 pickedType（"直接选 / 测试"两路互斥）、清空旧 answers。
      return { ...state, answers: {}, pickedType: null, result: null, step: 'test' }
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
      // 跳到结果页：清掉 pickedType 以保证"测试 vs 直接选"两路互斥，
      // 结果页只用 result 渲染，避免重选测试后又被 pickedType 串回旧值。
      return { ...state, result: action.result, pickedType: null, step: 'result' }
    case 'FEEDBACK_RECORDED':
      // 仅翻转"反馈已记录"标记。**严禁**修改 step / 触发 completeSetup 链路
      // ——反馈成功后用户必须留在结果页自行点"完成"才能继续（ISSUES P0-006）。
      return { ...state, feedbackRecorded: true }
    case 'BACK_TO_PICK':
      return { ...state, step: 'pick' }
    case 'BACK_TO_LOGIN':
      // M4 返回导航：昵称页 → 登录页。
      //   - step 切回 'login'；
      //   - 不清 email/token/nickname：登录页（LoginPage）用的是本地 useState，
      //     dispatch BACK_TO_LOGIN 只切 step；用户回登录页看到的是新空表单（本地态），
      //     store 里 email/token 保留供"再回昵称页"时 NicknamePage 仍能拿到。
      //   - 不清 answers / result / pickedType：与"BACK_TO_PICK 不清 result"
      //     契约一致——返回键只是 step 调度，不破坏用户已积累的数据。
      return { ...state, step: 'login' }
    case 'BACK_TO_NICKNAME':
      // M4 返回导航：选人格页 → 昵称页。
      //   - step 切回 'nickname'；
      //   - nickname 保留在 store，NicknamePage 用 state.nickname 初始化，
      //     所以再次进入昵称页时 input 自动回填已输入的内容（owner 要求"不清空已填"）；
      //   - 不清 pickedType / result / answers：返回键只切 step，保留后续步骤数据。
      return { ...state, step: 'nickname' }
    case 'BACK_TO_PICK_KEEP_ANSWERS':
      // M4 返回导航：测试页 → 选人格页（保留已答题进度）。
      //   - step 切回 'pick'；
      //   - **关键**：不动 state.answers，让用户再次进入 TestPage 时
      //     currentIdx = Object.keys(state.answers).length 仍是上次的进度；
      //   - 不动 result / pickedType / feedbackRecorded：测试页时这些字段本就是空，
      //     没必要清。
      // 与已有 BACK_TO_PICK 区分：BACK_TO_PICK 是结果页专用，不动 result；
      //   BACK_TO_PICK_KEEP_ANSWERS 是测试页专用，不动 answers。
      return { ...state, step: 'pick' }
    default:
      return state
  }
}

/** Provider 内部使用的 reducer 引用（与 setupReducer 同源） */
const reducer = setupReducer

interface Ctx {
  state: SetupState
  dispatch: Dispatch<SetupAction>
}

const SetupContext = createContext<Ctx | null>(null)

/** Provider：根组件用 */
export function SetupProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, INITIAL_SETUP_STATE)
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