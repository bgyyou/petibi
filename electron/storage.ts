// 【文件说明】Petibi 本地用户档案存储：把登录 token 与初始化结果写到 userData/profile.json，
// 主进程独占该文件，渲染进程通过 preload IPC 间接读写，避免渲染进程直接持 Node 能力。
//
// 设计要点：
//  - 单文件 JSON：键名稳定（token / profile），便于手工排查；
//  - 启动时读取 + 缺字段视为"未初始化"：UI 据此决定开 setup 窗还是 pet 窗；
//  - 写入采用「先写到临时文件再 rename」的原子模式，防止半截写入损坏档案。
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// 档案在磁盘上的形态：渲染进程侧 PetProfile 与之保持一致（src/api/types.ts）
export interface StoredProfile {
  token: string | null
  profile: {
    email: string
    nickname: string
    mbti: string
    subtype: 'stable' | 'sensitive'
    createdAt: string
  } | null
}

// 空档案：首次启动 / 数据损坏时的默认值
const EMPTY: StoredProfile = { token: null, profile: null }

// userData/profile.json 的绝对路径
function profilePath(): string {
  return join(app.getPath('userData'), 'profile.json')
}

/**
 * 读取档案：文件不存在或解析失败一律视为"未初始化"，返回空档案而不抛错。
 * 这样上层不必处理"首次启动没文件"的特例，分支收敛在一处。
 */
export async function readProfile(): Promise<StoredProfile> {
  const path = profilePath()
  try {
    const raw = await fs.readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoredProfile>
    // 顶层兜底：缺 token / profile 字段就补 null，避免上层访问 undefined
    return {
      token: parsed.token ?? null,
      profile: parsed.profile ?? null,
    }
  } catch {
    return { ...EMPTY }
  }
}

/**
 * 写入档案：先写到同名 .tmp 文件再 rename，保证并发场景下不会被读到半截内容。
 * 文件权限用 0o600（仅当前用户可读写），本地 token 不应被同机其他账户读到。
 */
export async function writeProfile(next: StoredProfile): Promise<void> {
  const path = profilePath()
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  await fs.rename(tmp, path)
}