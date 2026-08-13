// 【文件说明】渲染进程入口：把桌宠组件 App 挂载到 #root（React 18 createRoot 写法）
import { createRoot } from 'react-dom/client'
import App from './App'

// index.html 中必有 #root 挂载点，非空断言安全
const container = document.getElementById('root')!
createRoot(container).render(<App />)
