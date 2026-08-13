// 【文件说明】初始化流程窗（setup window）渲染进程入口：
// 把 setup/App.tsx 挂到 #root。与 src/main.tsx（桌宠窗）独立，避免互相污染。
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')!
createRoot(container).render(<App />)