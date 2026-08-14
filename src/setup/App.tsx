// 【文件说明】初始化流程窗根组件（T3 工单：DESIGN.md v1）：
// 根据当前 step 渲染对应页面；最外层套自绘标题栏 TitleBar。
// 5 步线性推进，不允许跳步（除明确 back），由 SetupProvider 统一管 state。
//
// M4 重测人格：URL ?mode=retest&initialStep=pick → 走「已登录用户重测」分支：
//   - 不渲染 LoginPage / NicknamePage（已登录用户无需再输验证码 / 改昵称）；
//   - 通过 INIT_FROM_PROFILE action 一次性把 token / email / nickname 写进 store；
//   - 切到 pick 步骤（用户可在 16 卡片里直接选，或继续走 test 步骤）。
// URL 参数由主进程 createSetupWindow({mode, initialStep}) 注入。
import { useEffect } from 'react'
import {
  INITIAL_SETUP_STATE,
  SetupProvider,
  useSetup,
  type SetupStep,
} from './state/setupStore'
import { LoginPage } from './pages/LoginPage'
import { NicknamePage } from './pages/NicknamePage'
import { PickTypePage } from './pages/PickTypePage'
import { TestPage } from './pages/TestPage'
import { ResultPage } from './pages/ResultPage'
import { TitleBar } from '../components/TitleBar'

/** 内部：根据 step 派发对应页面（与 Provider 分开，方便独立测试） */
function Router(): JSX.Element {
  const { state } = useSetup()
  switch (state.step) {
    case 'login':
      return <LoginPage />
    case 'nickname':
      return <NicknamePage />
    case 'pick':
      return <PickTypePage />
    case 'test':
      return <TestPage />
    case 'result':
      return <ResultPage />
    default:
      return <LoginPage />
  }
}

/**
 * M4 重测人格的副作用壳：负责读 URL → 拉本地档案 → dispatch INIT_FROM_PROFILE。
 * 与 Router 同级，挂在 Provider 内（确保 dispatch 可达），但只跑一次。
 */
function EntryModeBridge(): null {
  const { dispatch } = useSetup()
  useEffect(() => {
    // 仅在 URL 明确带 mode=retest 时才走这条捷径，否则保留首次注册的默认行为。
    const params = new URLSearchParams(window.location.search)
    const mode = params.get('mode')
    if (mode !== 'retest') return
    // initialStep 默认 'pick'；测试可走 'test'，但默认 UX 更友好是从卡片起步。
    const initialStepRaw = params.get('initialStep')
    const initialStep: SetupStep =
      initialStepRaw === 'test' ? 'test' : 'pick'
    // 拉本地 profile（retest 模式下用户必已有 profile，否则主进程根本不会拉 retest 窗）
    void window.petApi
      .getProfile()
      .then((stored) => {
        if (!stored.profile || !stored.token) {
          // 兜底：profile 缺失 = 实际不是 retest 场景 → 退化到 login
          console.warn('[setup] retest 模式下 profile 缺失，退回 login')
          return
        }
        dispatch({
          type: 'INIT_FROM_PROFILE',
          mode: 'retest',
          initialStep,
          token: stored.token,
          email: stored.profile.email,
          nickname: stored.profile.nickname,
          currentMbti: stored.profile.mbti,
        })
      })
      .catch((err: unknown) => {
        console.warn('[setup] retest 模式拉 profile 失败：', err)
      })
  }, [dispatch])
  return null
}

/** 根组件：自绘标题栏 + Provider + Router；与 main.tsx 简单对应 */
export function App(): JSX.Element {
  // 调试期打印：当前 store 初始 step（owner 自验时可对照）
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __setupInitial?: unknown }).__setupInitial = INITIAL_SETUP_STATE
  }
  return (
    <>
      <TitleBar
        title="Petibi 初始化"
        onMinimize={() => window.petApi?.minimizeSetup?.()}
        onClose={() => window.petApi?.cancelSetup?.()}
      />
      <SetupProvider>
        <EntryModeBridge />
        <Router />
      </SetupProvider>
    </>
  )
}