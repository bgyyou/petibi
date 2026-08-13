// 【文件说明】初始化流程窗根组件：根据当前 step 渲染对应页面。
// 5 步线性推进，不允许跳步（除明确 back），由 SetupProvider 统一管 state。
import { SetupProvider, useSetup } from './state/setupStore'
import { LoginPage } from './pages/LoginPage'
import { NicknamePage } from './pages/NicknamePage'
import { PickTypePage } from './pages/PickTypePage'
import { TestPage } from './pages/TestPage'
import { ResultPage } from './pages/ResultPage'

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

/** 根组件：Provider + Router；与 main.tsx 简单对应 */
export function App(): JSX.Element {
  return (
    <SetupProvider>
      <Router />
    </SetupProvider>
  )
}