// 【文件说明】桌宠 sprite 路径拼接的纯函数（M4 重测人格：把 sprite 路径前缀从硬编码
// 改为按当前 mbti 动态拼）。
//
// 设计要点：
//   - 启动期 pet App 调 getCurrentMbti() 拿到当前人格（来自主进程读 profile.json）；
//   - 重测完成后主进程广播 pet:sprite-change，pet App 更新 mbti 后立即重新拼路径；
//   - 16 型白名单校验：mbti 不在白名单时回退 'intj' 兜底（防路径穿越/数据污染）；
//   - sprite 相对 URL 形如 "sprites/<mbti>/<frame>.png"，与 vite publicDir 配置一致。
//
// 把拼接抽到独立文件而不是写在 App.tsx 内，好处：
//   1. 不依赖 React runtime，vitest node 环境直接跑；
//   2. 路径生成规则一处定义、一处测试（重构不会破）。

/** 16 型人格白名单：与 electron/main.ts 的 MBTI_TYPE_RE 保持一致 */
export const MBTI_TYPE_RE = /^(INTJ|INTP|ENTJ|ENTP|INFJ|INFP|ENFJ|ENFP|ISTJ|ISFJ|ESTJ|ESFJ|ISTP|ISFP|ESTP|ESFP)$/i

/** 兜底人格：白名单校验失败或 mbti 缺失时使用 */
export const FALLBACK_MBTI = 'intj'

/** 动画状态：与 src/App.tsx 的 PetState 保持一致 */
export type PetState = 'idle' | 'blink' | 'happy' | 'thinking'

/**
 * 校验 mbti 是否在 16 型白名单内；不合法返回 FALLBACK_MBTI（lowercase）。
 * 大小写不敏感：'INTJ' / 'intj' / 'Intj' 都通过。
 */
export function sanitizeMbti(mbti: string | null | undefined): string {
  if (typeof mbti !== 'string' || mbti.length === 0) return FALLBACK_MBTI
  return MBTI_TYPE_RE.test(mbti) ? mbti.toLowerCase() : FALLBACK_MBTI
}

/**
 * 按当前 mbti 拼出 4 状态各自的 sprite 相对路径。
 * owner 实测决策（2026-08-14）：idle/happy 单帧静态展示，blink/thinking 双帧反馈。
 */
export function buildSpritePaths(mbti: string): Record<PetState, string[]> {
  const safe = sanitizeMbti(mbti)
  return {
    idle: [`sprites/${safe}/idle_0.png`],
    blink: [`sprites/${safe}/blink_0.png`, `sprites/${safe}/blink_1.png`],
    happy: [`sprites/${safe}/idle_0.png`],
    thinking: [`sprites/${safe}/thinking_0.png`, `sprites/${safe}/thinking_1.png`],
  }
}

/** 给定 mbti + 状态 + 帧号，返回具体一张帧的相对路径（src/App.tsx 渲染时调用） */
export function spritePath(
  mbti: string,
  state: PetState,
  frameIndex: number,
): string {
  const paths = buildSpritePaths(mbti)[state]
  // 帧号越界时回退到第 0 帧（防御性，避免 React 渲染时崩）
  const idx = frameIndex >= 0 && frameIndex < paths.length ? frameIndex : 0
  return paths[idx]
}