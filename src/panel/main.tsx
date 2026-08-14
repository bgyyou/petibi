// 【文件说明】主面板窗（panel window）渲染进程入口（T3 工单：DESIGN.md v1）：
// 把 panel/App.tsx 挂到 #root；引入设计令牌 + 标题栏样式。
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '../styles/tokens.css'
import '../styles/titlebar.css'
import './styles.css'

const container = document.getElementById('root')!
createRoot(container).render(<App />)