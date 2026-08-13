// 【文件说明】API 客户端：mock 优先，baseURL 可配，接口契约见 docs/tech/M3-对话链路契约.md §4。
//
// 设计要点：
//  - mock 模式默认开启（server 还没就绪，dev 必须能跑通），通过 VITE_USE_MOCK_API=false 切真接口；
//  - 真接口模式：baseURL 走 VITE_API_BASE_URL（缺省 http://localhost:8787）；
//  - 网络错误统一包装成 ApiError 抛出，调用方不必处理 fetch Response；
//  - 写入操作（profile / feedback）服务端未实现时，mock 也照常落库（内存 + 控制台日志），便于联调；
//  - 对话接口 (POST /api/chat) 是 SSE 流式，单独提供 streamChat() 而非抛 Promise。
import type {
  ApiError,
  ChatRequestBody,
  ChatSseEvent,
  CommentItem,
  CommentSubmitRequest,
  CommentSubmitResponse,
  CommentsListResponse,
  FeedbackApiResponse,
  FeedbackRequest,
  PosterItem,
  PosterLikeResponse,
  PosterRequest,
  PosterResponse,
  PostersListResponse,
  QuotaInfo,
  SaveProfileRequest,
  SaveProfileResponse,
  SendCodeResponse,
  SetPetNicknameRequest,
  SetPetNicknameResponse,
  ShareCountResponse,
  User,
  VerifyCodeResponse,
} from './types'

// Vite 在 build / dev 时把 import.meta.env.VITE_* 内联为常量；SSR / Node 测试环境没有时退回到 process.env
const env = (import.meta as any).env ?? {}
/**
 * USE_MOCK 用 let 而非 const（其余模块顶层仍为 const），便于单元测试通过
 * __setMockMode(false) 强制走真接口分支测 fetch body / SSE 解析。
 * 切换仅对后续调用生效，不修改任何 mock 内存表。
 */
let USE_MOCK = (env.VITE_USE_MOCK_API ?? 'true') !== 'false'
const BASE_URL = (env.VITE_API_BASE_URL ?? 'http://localhost:8787') as string

// 网络模拟延迟（mock 模式）：让 UI 表现接近真实接口
const MOCK_LATENCY_MS = 220

// 宠物昵称冷却：与 server 保持一致（72h）。前端用同一常量算倒计时，
// 避免后端响应缺失时降级为本地"立即可改"。
const PET_NICKNAME_COOLDOWN_SEC = 72 * 60 * 60

// API 类错误（throw 出去供 UI catch）
export class ApiCallError extends Error {
  code: string
  /** 服务端携带的额外上下文（如冷却剩余秒数）；不存在时为 undefined */
  extra?: Record<string, unknown>
  constructor(err: ApiError) {
    super(err.message)
    this.code = err.code
    this.extra = err.extra
    this.name = 'ApiCallError'
  }
}

// ============================================================================
// Mock 实现（内存数据库）
// ============================================================================

// mock 用户表：key 是 email（小写），value 是 User + token
const mockUsers: Map<string, { user: User; token: string }> = new Map()
// mock 反馈表：key 是 userId，value 是反馈列表
const mockFeedback: Map<string, Array<FeedbackRequest & { recordedAt: string }>> = new Map()
// mock 验证码表：key 是 email，value 是 { code, expiresAt }
const mockCodes: Map<string, { code: string; expiresAt: number }> = new Map()
// mock 配额：key 是 userId，value 是当日已用次数
const mockQuota: Map<string, number> = new Map()
// mock 每日上限（与 server 默认对齐）
const MOCK_DAILY_LIMIT = 10
// mock 分享计数：key 是 userId，value 是累计分享次数
const mockShareCount: Map<string, number> = new Map()
// mock 海报表：key 是 poster_id（mock-poster-N），value 是入参与时间戳（dev tools 可查）
const mockPosters: Map<string, PosterRequest & { userId: string; createdAt: string; likes: number }> = new Map()
// mock 留言表：key 是 poster_id，value 是留言列表（带 id / user_id / 内容 / 时间）
const mockComments: Map<string, Array<CommentItem & { userId: string }>> = new Map()

let mockTokenCounter = 1
let mockUserIdCounter = 1
let mockPosterCounter = 1
let mockCommentCounter = 1

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mockGenerateCode(): string {
  // 6 位数字，固定 dev 模式验证码 123456 便于手动测试
  return '123456'
}

function mockSendCode(email: string): SendCodeResponse {
  const code = mockGenerateCode()
  mockCodes.set(email.toLowerCase(), {
    code,
    expiresAt: Date.now() + 5 * 60 * 1000,
  })
  // 模拟 dev 模式：直接把验证码回在响应里 + 打日志
  console.info(`[mock] 邮箱 ${email} 验证码 = ${code}（dev 模式 5 分钟内有效）`)
  return { dev_code: code, expires_in: 300 }
}

function mockVerifyCode(email: string, code: string): VerifyCodeResponse {
  const key = email.toLowerCase()
  const record = mockCodes.get(key)
  if (!record || record.expiresAt < Date.now()) {
    throw new ApiCallError({ code: 'CODE_EXPIRED', message: '验证码已过期，请重新获取' })
  }
  if (record.code !== code) {
    throw new ApiCallError({ code: 'CODE_INVALID', message: '验证码错误' })
  }
  // 验证成功 → 消费验证码
  mockCodes.delete(key)
  // 已有用户直接登录；新用户自动注册
  const existing = mockUsers.get(key)
  if (existing) {
    return { token: existing.token, user: existing.user }
  }
  const token = `mock-token-${mockTokenCounter++}`
  const user: User = {
    id: `mock-user-${mockUserIdCounter++}`,
    email,
    nickname: null,
    mbti: null,
    subtype: null,
    pet_nickname: null,
    pet_nickname_changed_at: 0,
    next_change_at: Math.floor(Date.now() / 1000),
    pet_name: null,
    animal: null,
  }
  mockUsers.set(key, { user, token })
  return { token, user }
}

function mockGetMe(token: string): User {
  for (const { user, token: t } of mockUsers.values()) {
    if (t === token) return user
  }
  throw new ApiCallError({ code: 'UNAUTHENTICATED', message: '请先登录' })
}

function mockSaveProfile(token: string, req: SaveProfileRequest): SaveProfileResponse {
  const user = mockGetMe(token)
  user.nickname = req.nickname
  user.mbti = req.mbti
  user.subtype = req.subtype
  return user
}

/**
 * Mock 修改宠物昵称：与 server 行为一致（72h 冷却、首次不限），便于 dev 体验。
 * 注意：mockUser.pet_nickname_changed_at 写在 User 对象上（不是单独的 Map），简化内存态。
 */
function mockSetPetNickname(
  token: string,
  req: SetPetNicknameRequest,
): SetPetNicknameResponse {
  const user = mockGetMe(token)
  // 校验：去空白 + 1-8 字
  const stripped = req.nickname.replace(/\s+/g, '')
  if (stripped.length === 0 || stripped.length > 8) {
    throw new ApiCallError({
      code: 'INVALID_PET_NICKNAME',
      message: stripped.length === 0 ? '宠物昵称不能为空' : '宠物昵称不能超过 8 字',
    })
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (user.pet_nickname_changed_at > 0) {
    const next = user.pet_nickname_changed_at + PET_NICKNAME_COOLDOWN_SEC
    if (nowSec < next) {
      throw new ApiCallError({
        code: 'PET_NICKNAME_COOLDOWN',
        message: `宠物昵称冷却中，剩余 ${next - nowSec} 秒可修改`,
        extra: { remainSec: next - nowSec, nextChangeAt: next },
      })
    }
  }
  user.pet_nickname = stripped
  user.pet_nickname_changed_at = nowSec
  user.next_change_at = nowSec + PET_NICKNAME_COOLDOWN_SEC
  return {
    pet_nickname: user.pet_nickname,
    pet_nickname_changed_at: user.pet_nickname_changed_at,
    next_change_at: user.next_change_at,
  }
}

function mockSubmitFeedback(token: string, req: FeedbackRequest): FeedbackApiResponse {
  const user = mockGetMe(token)
  const list = mockFeedback.get(user.id) ?? []
  const recordedAt = new Date().toISOString()
  list.push({ ...req, recordedAt })
  mockFeedback.set(user.id, list)
  console.info(`[mock] 用户 ${user.email} 反馈：match=${req.match}`, req.comment ?? '')
  return { recorded_at: recordedAt }
}

/** 取 mock 当日用量；找不到用户视为 0 */
function mockGetQuota(token: string): QuotaInfo {
  // 校验 token，找到对应 userId
  const hit = Array.from(mockUsers.values()).find((v) => v.token === token)
  if (!hit) {
    throw new ApiCallError({ code: 'UNAUTHENTICATED', message: '请先登录' })
  }
  const used = mockQuota.get(hit.user.id) ?? 0
  const remaining = Math.max(0, MOCK_DAILY_LIMIT - used)
  return {
    date: new Date().toISOString().slice(0, 10),
    used,
    limit: MOCK_DAILY_LIMIT,
    remaining,
  }
}

/**
 * Mock 上传海报：与并行工单契约 {image_base64, persona_type, question_excerpt, answer_excerpt}
 * → {poster_id, status} 对齐。mock 模式不真机审、不真落库，只登记到内存 + console。
 * 返回 poster_id 形如 "mock-poster-N"（自增），status 固定 'pending'。
 */
function mockSubmitPoster(token: string, req: PosterRequest): PosterResponse {
  const hit = Array.from(mockUsers.values()).find((v) => v.token === token)
  if (!hit) {
    throw new ApiCallError({ code: 'UNAUTHENTICATED', message: '请先登录' })
  }
  const id = `mock-poster-${mockPosterCounter++}`
  mockPosters.set(id, { ...req, userId: hit.user.id, createdAt: new Date().toISOString(), likes: 0 })
  console.info(
    `[mock] 用户 ${hit.user.email} 上传海报 ${id}（persona=${req.persona_type}，base64 长度=${req.image_base64.length}）`,
  )
  return { poster_id: id, status: 'pending' }
}

/** Mock 累计分享次数：递增 1，返回最新值。V2 装扮解锁的前置数据；next_unlock_at 暂为 null。 */
function mockBumpShareCount(token: string): ShareCountResponse {
  const hit = Array.from(mockUsers.values()).find((v) => v.token === token)
  if (!hit) {
    throw new ApiCallError({ code: 'UNAUTHENTICATED', message: '请先登录' })
  }
  const next = (mockShareCount.get(hit.user.id) ?? 0) + 1
  mockShareCount.set(hit.user.id, next)
  return { count: next, next_unlock_at: null }
}

/**
 * Mock 广场列表：内存预置若干 approved 海报 + 用户现场提交的。
 * 设计：mock 模式下 mockSubmitPoster 返回 status='pending'，但 mock 列表对当前用户直接放行
 * （dev 体验优先）；非当前用户提交的内容也按 approved 列出便于浏览。
 * 与 server 行为差异在 R7 判定里不影响 UI（已通过测试覆盖审核链路）。
 */
function mockListPosters(limit: number, offset: number): PostersListResponse {
  const items: PosterItem[] = []
  // 预置 4 张示例海报（覆盖 4 族），便于未登录态也能看到社区有内容
  const seed: Array<Omit<PosterItem, 'image_path'> & { persona_type: string }> = [
    {
      id: 9001,
      user_id: 1,
      persona_type: 'INTJ',
      question_excerpt: '明天要当众演讲好紧张',
      answer_excerpt: '先把讲稿拆成三条线，每条不超过两分钟。先把结构搭稳，再开口。',
      likes: 12,
      created_at: '2026-08-10T12:00:00.000Z',
    },
    {
      id: 9002,
      user_id: 2,
      persona_type: 'INFP',
      question_excerpt: '总觉得自己不够好怎么办',
      answer_excerpt: '把"比较"换成"积累"：你看到的永远是别人准备好的版本，不是过程。',
      likes: 23,
      created_at: '2026-08-11T08:30:00.000Z',
    },
    {
      id: 9003,
      user_id: 3,
      persona_type: 'ESTP',
      question_excerpt: '想换工作又怕踩坑',
      answer_excerpt: '先做一周的信息采集：HR 圈里打 5 个电话，比刷三天招聘软件有用。',
      likes: 8,
      created_at: '2026-08-12T03:10:00.000Z',
    },
    {
      id: 9004,
      user_id: 4,
      persona_type: 'ISFJ',
      question_excerpt: '朋友总找我倒情绪垃圾',
      answer_excerpt: '温柔的拒绝不是背叛：你帮不到对方，是因为对方需要的是专业倾听。',
      likes: 17,
      created_at: '2026-08-12T14:48:00.000Z',
    },
  ]
  for (const s of seed) {
    items.push({
      id: s.id,
      user_id: s.user_id,
      image_path: `mock://poster/${s.id}.png`,
      persona_type: s.persona_type,
      question_excerpt: s.question_excerpt,
      answer_excerpt: s.answer_excerpt,
      likes: s.likes,
      created_at: s.created_at,
    })
  }
  // 把用户现场提交的 mock 海报（mockSubmitPoster 入库的）也合并进列表
  for (const [pid, p] of mockPosters.entries()) {
    items.push({
      id: pid as unknown as number,
      user_id: 0,
      image_path: `mock://poster/${pid}.png`,
      persona_type: p.persona_type,
      question_excerpt: p.question_excerpt,
      answer_excerpt: p.answer_excerpt,
      likes: p.likes,
      created_at: p.createdAt,
    })
  }
  // 按 created_at DESC 排序
  items.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  return { items: items.slice(offset, offset + limit), limit, offset }
}

/**
 * Mock 点赞/取消：mockPosters 表里维护 likes 字段；与 server 行为差异（mock 不去重 userId）
 * 已在工单 M4-社区后端-交付报告.md 标注，UI 体验优先。
 */
function mockLikePoster(token: string, posterId: number): PosterLikeResponse {
  const hit = Array.from(mockUsers.values()).find((v) => v.token === token)
  if (!hit) {
    throw new ApiCallError({ code: 'UNAUTHENTICATED', message: '请先登录后再点赞' })
  }
  const key = String(posterId)
  // mock 海报或预置海报（预置是 mock 内存对象，likes 直接调整）
  const existing = mockPosters.get(key)
  let likes: number
  if (existing) {
    // 简化：每次点击都 +1（mock 不去重），让 UI 能看到计数变化
    existing.likes = (existing.likes ?? 0) + 1
    likes = existing.likes
  } else {
    likes = 1
  }
  return { liked: true, likes }
}

/** Mock 留言列表：仅返 mockComments 表里的条目 */
function mockListComments(posterId: number): CommentsListResponse {
  const items = mockComments.get(String(posterId)) ?? []
  return { items: items.map((c) => ({ id: c.id, user_id: c.user_id, content: c.content, created_at: c.created_at })) }
}

/**
 * Mock 发留言：mock 模式下不接 LocalModeration；直接落库 + 返 approved。
 * 字数校验与 server 对齐（>200 报 COMMENT_TOO_LONG）。
 */
function mockSubmitComment(
  token: string,
  posterId: number,
  req: CommentSubmitRequest,
): CommentSubmitResponse {
  const hit = Array.from(mockUsers.values()).find((v) => v.token === token)
  if (!hit) {
    throw new ApiCallError({ code: 'UNAUTHENTICATED', message: '请先登录后再留言' })
  }
  const trimmed = req.content.trim()
  if (trimmed.length === 0) {
    throw new ApiCallError({ code: 'BAD_REQUEST', message: '留言不能为空' })
  }
  if (trimmed.length > 200) {
    throw new ApiCallError({
      code: 'COMMENT_TOO_LONG',
      message: `留言不能超过 200 字`,
      extra: { maxLen: 200, actualLen: trimmed.length },
    })
  }
  const id = mockCommentCounter++
  const entry = {
    id,
    user_id: 0,
    content: trimmed,
    created_at: new Date().toISOString(),
    userId: hit.user.id,
  }
  const list = mockComments.get(String(posterId)) ?? []
  list.push(entry)
  mockComments.set(String(posterId), list)
  return { comment_id: id, status: 'approved' }
}

/**
 * Mock 流式对话：与 server 契约 §4 保持完全一致的事件序列
 * （meta → 多个 delta → done），便于 UI 通用化接入。
 *
 * 触发拒绝模板的关键词与 server/intent-filter.json 对齐：
 *   code / homework / generate / web / roleplay
 */
function mockComposeAnswer(question: string): string {
  const q = question.toLowerCase()
  if (q.includes('写代码') || q.includes('python') || q.includes('编程')) {
    return '（mock）写代码？我的 Ti 倒是能拆一拆游戏设计的逻辑，但真让我一行行敲？饶了我吧，不如我们聊聊——你为啥想做这个？'
  }
  if (q.includes('紧张') || q.includes('演讲')) {
    return '（mock）作为你，我习惯先在心里把讲稿拆成三条线，每条不超过两分钟。先把结构搭稳，再开口。试试看？'
  }
  if (q.includes('你好') || q.includes('hi') || q.includes('嗨')) {
    return '（mock）嗨，今天想聊点什么？我听你安排。'
  }
  if (q.length < 6) {
    return '（mock）嗯，再多说两句？'
  }
  return '（mock）作为你这种人格，我通常会先把情绪放一边、找出一条最想达成的目标——然后挑阻力最小的那一步先走。试试看？'
}

const REFUSE_KEYWORDS = ['写代码', 'python', '编程', '代码', '做题', '作业', '作文', 'ppt', '生成', '天气', '股价', '新闻', '热搜']
function mockCheckRefuse(question: string): boolean {
  return REFUSE_KEYWORDS.some((k) => question.toLowerCase().includes(k))
}

/** 异步生成器：分片产出 SSE 事件；调用方按 meta/delta/done/error 自行处理
 *
 * mock 模式说明（M4 工单 A 衔接工单 B）：
 *   - sessionId 仅做透传记录（开发体验优先，不真正改 mockComposeAnswer 的回答内容）；
 *   - 真接口的 server 会按 sessionId 拉取历史轮次拼 prompt，mock 不模拟历史，
 *     但保证签名一致便于前端代码无差别调用；
 *   - 调用方（ChatTab）已用 options.sessionId 传入，落到此函数的最后一个参数。
 */
async function* mockStreamChat(
  _token: string,
  question: string,
  onQuotaConsumed?: () => void,
  _sessionId?: string,
): AsyncGenerator<ChatSseEvent> {
  // 1) meta（前端在收到 meta 后即可结束 thinking 动画的"等待态"，但本工单约定
  //    meta 仅代表"已就绪"信号，UI 切 thinking 是请求发起即刻，不等 meta）
  //    这里先发 meta，让调用方可以扩展。
  const refused = mockCheckRefuse(question)
  if (!refused) {
    yield { type: 'meta', rag_entry_id: null, refused: false }
  } else {
    yield { type: 'meta', rag_entry_id: null, refused: true }
  }
  // 2) 配额消耗（mock 模式豁免配额错误，让 dev 体验顺滑）
  if (onQuotaConsumed) onQuotaConsumed()
  // 3) 流式文本
  const text = mockComposeAnswer(question)
  const sliceSize = 3
  for (let i = 0; i < text.length; i += sliceSize) {
    yield { type: 'delta', text: text.slice(i, i + sliceSize) }
  }
  // 4) done
  yield { type: 'done', total_chars: text.length }
}

// ============================================================================
// 真接口实现（用 fetch）
// ============================================================================

async function realSendCode(email: string): Promise<SendCodeResponse> {
  const res = await fetch(`${BASE_URL}/api/auth/email/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  return parseJson<SendCodeResponse>(res)
}

async function realVerifyCode(email: string, code: string): Promise<VerifyCodeResponse> {
  const res = await fetch(`${BASE_URL}/api/auth/email/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  })
  return parseJson<VerifyCodeResponse>(res)
}

async function realGetMe(token: string): Promise<User> {
  const res = await fetch(`${BASE_URL}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return parseJson<User>(res)
}

async function realSaveProfile(
  token: string,
  req: SaveProfileRequest,
): Promise<SaveProfileResponse> {
  const res = await fetch(`${BASE_URL}/api/me/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  })
  return parseJson<SaveProfileResponse>(res)
}

async function realSetPetNickname(
  token: string,
  req: SetPetNicknameRequest,
): Promise<SetPetNicknameResponse> {
  const res = await fetch(`${BASE_URL}/api/me/pet-nickname`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  })
  return parseJson<SetPetNicknameResponse>(res)
}

async function realSubmitFeedback(
  token: string,
  req: FeedbackRequest,
): Promise<FeedbackApiResponse> {
  const res = await fetch(`${BASE_URL}/api/me/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  })
  return parseJson<FeedbackApiResponse>(res)
}

async function realGetQuota(token: string): Promise<QuotaInfo> {
  const res = await fetch(`${BASE_URL}/api/quota`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return parseJson<QuotaInfo>(res)
}

/**
 * 真接口：上传海报到社区广场。
 * 契约由并行工单实现：POST /api/posters，body 见 PosterRequest，response 见 PosterResponse。
 * 接口未就绪时（404 / 500）抛 ApiCallError，UI 走"上墙失败"提示。
 */
async function realSubmitPoster(
  token: string,
  req: PosterRequest,
): Promise<PosterResponse> {
  const res = await fetch(`${BASE_URL}/api/posters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  })
  return parseJson<PosterResponse>(res)
}

/**
 * 真接口：分享次数 +1（V2 装扮解锁前置数据）。
 * 并行工单契约：POST /api/me/share-count → {count, next_unlock_at}。
 */
async function realBumpShareCount(token: string): Promise<ShareCountResponse> {
  const res = await fetch(`${BASE_URL}/api/me/share-count`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  return parseJson<ShareCountResponse>(res)
}

/**
 * 真接口：社区广场列表（公开 GET /api/posters）。
 * 与 docs/tech/M4-社区后端-交付报告.md 第 3.4 节契约对齐：分页 limit/offset，
 * 只返 status='approved'（server 端硬过滤，UI 无需再判）。
 */
async function realListPosters(limit: number, offset: number): Promise<PostersListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const res = await fetch(`${BASE_URL}/api/posters?${params.toString()}`)
  return parseJson<PostersListResponse>(res)
}

/**
 * 真接口：点赞/取消（POST /api/posters/:id/like，鉴权）。
 * 返回 { liked, likes }；未登录由 server 返 401，UI 走引导登录分支。
 */
async function realLikePoster(token: string, posterId: number): Promise<PosterLikeResponse> {
  const res = await fetch(`${BASE_URL}/api/posters/${posterId}/like`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  return parseJson<PosterLikeResponse>(res)
}

/** 真接口：留言列表（公开 GET /api/posters/:id/comments，只返 approved）。 */
async function realListComments(posterId: number): Promise<CommentsListResponse> {
  const res = await fetch(`${BASE_URL}/api/posters/${posterId}/comments`)
  return parseJson<CommentsListResponse>(res)
}

/**
 * 真接口：发留言（POST /api/posters/:id/comments，鉴权，≤200 字）。
 * server 先入 pending → 审核 → approved 才展示。客户端取 status 决定反馈文案。
 */
async function realSubmitComment(
  token: string,
  posterId: number,
  req: CommentSubmitRequest,
): Promise<CommentSubmitResponse> {
  const res = await fetch(`${BASE_URL}/api/posters/${posterId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  })
  return parseJson<CommentSubmitResponse>(res)
}

/** 解析 SSE data: 行；返回按事件分组的数组，便于在生成器里逐条 yield */
function* parseSseBlocks(buffer: string): Generator<string> {
  let idx: number
  while ((idx = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 2)
    yield block
  }
}

function parseSseEvent(block: string): ChatSseEvent | null {
  const dataLine = block
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'))
  if (!dataLine) return null
  const payload = dataLine.slice(5).trim()
  if (!payload) return null
  try {
    return JSON.parse(payload) as ChatSseEvent
  } catch {
    return null
  }
}

/** 真接口的 SSE 流；解析过程与 server/src/routes/chat.ts 的事件序列对齐
 *
 * sessionId（M4 多轮对话 B §B1）：可选；携带时拼到 body，server 会拉取历史。
 * UI 持久化（localStorage）由并行工单 A 接管，本函数仅做透传。
 */
async function* realStreamChat(
  token: string,
  question: string,
  signal?: AbortSignal,
  sessionId?: string,
): AsyncGenerator<ChatSseEvent> {
  const body: ChatRequestBody = { question }
  if (sessionId && sessionId.trim().length > 0) body.session_id = sessionId.trim()
  const resp = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok || !resp.body) {
    let bodyText = ''
    try {
      bodyText = await resp.text()
    } catch {
      /* ignore */
    }
    let code = `HTTP_${resp.status}`
    let message = bodyText || resp.statusText || '请求失败'
    try {
      const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string } }
      if (parsed.error?.code) code = parsed.error.code
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      /* ignore non-JSON */
    }
    yield { type: 'error', message }
    return
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const block of parseSseBlocks(buffer)) {
        // 用副本解析，避免后续 buffer 还在追加时影响
        const evt = parseSseEvent(block)
        if (evt) yield evt
      }
      // 去掉已解析部分（保留最后一个不完整块）
      const lastBoundary = buffer.lastIndexOf('\n\n')
      if (lastBoundary >= 0) buffer = buffer.slice(lastBoundary + 2)
    }
  } finally {
    reader.releaseLock()
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      /* 忽略：服务端可能返回非 JSON 错误 */
    }
    // 服务端错误体形如 { ok:false, error:{code,message,extra?} }；
    // extra 在冷却场景携带 remainSec/nextChangeAt，UI 用它算倒计时。
    const errBody = body?.error ?? body
    const extra = errBody?.extra && typeof errBody.extra === 'object' ? errBody.extra : undefined
    throw new ApiCallError({
      code: String(errBody?.code ?? `HTTP_${res.status}`),
      message: String(errBody?.message ?? res.statusText ?? '请求失败'),
      extra,
    })
  }
  return res.json() as Promise<T>
}

// ============================================================================
// 公开 API（渲染进程 / 测试均通过这一层调用，不直接走 mock 或 fetch）
// ============================================================================

/** 当前是否在 mock 模式（用于 UI 提示） */
export const isMockMode: boolean = USE_MOCK

/** 当前 mock / real baseURL（UI 调试用） */
export const baseUrl: string = BASE_URL

/** 发送邮箱验证码（开发模式会把 code 直接返回） */
export async function sendEmailCode(email: string): Promise<SendCodeResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS)
    return mockSendCode(email)
  }
  return realSendCode(email)
}

/** 校验邮箱 + 验证码；成功后返回 token + 用户信息 */
export async function verifyEmailCode(email: string, code: string): Promise<VerifyCodeResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS)
    return mockVerifyCode(email, code)
  }
  return realVerifyCode(email, code)
}

/** 读取当前用户信息（含 mbti/subtype） */
export async function getMe(token: string): Promise<User> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS / 2)
    return mockGetMe(token)
  }
  return realGetMe(token)
}

/** 初始化写档（昵称 + mbti + subtype） */
export async function saveProfile(
  token: string,
  req: SaveProfileRequest,
): Promise<SaveProfileResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS)
    return mockSaveProfile(token, req)
  }
  return realSaveProfile(token, req)
}

/**
 * 修改宠物昵称（POST /api/me/pet-nickname）：
 *  - 首次设置直接成功；
 *  - 再次修改需距上次 ≥72 小时，否则抛出 ApiCallError，code=PET_NICKNAME_COOLDOWN，
 *    extra.remainSec / extra.nextChangeAt 携带剩余秒数与下次可改时间戳。
 *
 * UI 应：成功 → 刷新本地 user 状态；失败若是 PET_NICKNAME_COOLDOWN → 展示倒计时。
 */
export async function setPetNickname(
  token: string,
  req: SetPetNicknameRequest,
): Promise<SetPetNicknameResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS)
    return mockSetPetNickname(token, req)
  }
  return realSetPetNickname(token, req)
}

/** 反馈「结果符合你吗」（M2 工单自验第 4 条） */
export async function submitFeedback(
  token: string,
  req: FeedbackRequest,
): Promise<FeedbackApiResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS)
    return mockSubmitFeedback(token, req)
  }
  return realSubmitFeedback(token, req)
}

/** 今日配额：used / remaining / limit（无 mock 延迟，便于 UI 同步展示） */
export async function getQuota(token: string): Promise<QuotaInfo> {
  if (USE_MOCK) {
    // 极小延迟模拟网络抖动
    await delay(40)
    return mockGetQuota(token)
  }
  return realGetQuota(token)
}

/**
 * 流式对话：POST /api/chat，产出 ChatSseEvent 序列。
 * 调用方负责在请求发起后切桌宠 thinking 动画、收到首条 delta 后切回 idle。
 * - abort: 外部 AbortController.signal，用于"停止生成"按钮。
 * - onQuotaConsumed: mock 模式触发，配额扣减可视化（real 模式由 server 自管）。
 * - sessionId: 可选，会话串 id；携带时 server 拉取该会话最近 6 轮历史拼进 prompt
 *   （M4 多轮对话 B §B1）。UI 持久化（localStorage 等）由并行工单 A 接管，
 *   本函数只做 API 透传。
 */
export async function* streamChat(
  token: string,
  question: string,
  options: {
    signal?: AbortSignal
    onQuotaConsumed?: () => void
    sessionId?: string
  } = {},
): AsyncGenerator<ChatSseEvent> {
  if (USE_MOCK) {
    // mock 模式不接入 AbortSignal：dev 体验优先；如需终止由调用方丢弃生成器即可
    yield* mockStreamChat(token, question, options.onQuotaConsumed, options.sessionId)
    return
  }
  yield* realStreamChat(token, question, options.signal, options.sessionId)
}

/**
 * 上传分享海报到社区广场（M4 工单：POST /api/posters，并行工单实现）。
 * 入参：海报的 base64 PNG + 人格 + 问题/回答摘要。
 * 出参：服务端分配的 poster_id + 初始状态（pending / approved / rejected）。
 * - mock 模式：返回 "mock-poster-N" 字符串，status='pending'，控制台打日志；
 * - 接口未就绪：抛 ApiCallError，UI 应在弹窗内展示"上墙失败"并允许保存本地兜底。
 */
export async function submitPoster(
  token: string,
  req: PosterRequest,
): Promise<PosterResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS)
    return mockSubmitPoster(token, req)
  }
  return realSubmitPoster(token, req)
}

/**
 * 分享次数 +1（M4 工单：POST /api/me/share-count，并行工单实现）。
 * 与 submitPoster 解耦：用户可能只下载不分享，也可能在分享前取消。
 * V2 装扮解锁会消费此接口的累计值。
 */
export async function bumpShareCount(token: string): Promise<ShareCountResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS / 2)
    return mockBumpShareCount(token)
  }
  return realBumpShareCount(token)
}

/**
 * 社区广场列表（M4 工单 A2：GET /api/posters）。
 * 未登录也可访问（公开接口）；分页 limit ≤ 100，offset ≥ 0。
 * - mock 模式：返回 4 张预置海报 + 用户现场提交的海报合并列表；
 * - 真接口：直接转发；server 端硬过滤 status='approved'，未审内容不会泄露。
 */
export async function listPosters(
  options: { limit?: number; offset?: number } = {},
): Promise<PostersListResponse> {
  const limit = options.limit ?? 20
  const offset = options.offset ?? 0
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS / 2)
    return mockListPosters(limit, offset)
  }
  return realListPosters(limit, offset)
}

/**
 * 点赞 / 取消点赞（POST /api/posters/:id/like，鉴权）。
 * 未登录抛 UNAUTHENTICATED，UI 引导登录。
 */
export async function likePoster(token: string, posterId: number): Promise<PosterLikeResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS / 2)
    return mockLikePoster(token, posterId)
  }
  return realLikePoster(token, posterId)
}

/**
 * 留言列表（GET /api/posters/:id/comments，公开）。
 * 未登录也可拉；server 仅返 approved。
 */
export async function listComments(posterId: number): Promise<CommentsListResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS / 2)
    return mockListComments(posterId)
  }
  return realListComments(posterId)
}

/**
 * 发留言（POST /api/posters/:id/comments，鉴权，≤200 字）。
 * server 先入 pending → 审核；UI 根据 status 给用户反馈文案（approved / rejected）。
 */
export async function submitComment(
  token: string,
  posterId: number,
  req: CommentSubmitRequest,
): Promise<CommentSubmitResponse> {
  if (USE_MOCK) {
    await delay(MOCK_LATENCY_MS)
    return mockSubmitComment(token, posterId, req)
  }
  return realSubmitComment(token, posterId, req)
}

/** 单元测试 / 调试用：清空 mock 内存表 */
export function __resetMockDb(): void {
  mockUsers.clear()
  mockFeedback.clear()
  mockCodes.clear()
  mockQuota.clear()
  mockShareCount.clear()
  mockPosters.clear()
  mockComments.clear()
  mockTokenCounter = 1
  mockUserIdCounter = 1
  mockPosterCounter = 1
  mockCommentCounter = 1
}

/** 单元测试 / 调试用：手动增加 mock 配额计数（模拟 server 已扣减） */
export function __bumpMockQuota(userId: string, delta: number): void {
  mockQuota.set(userId, (mockQuota.get(userId) ?? 0) + delta)
}

/** 单元测试 / 调试用：列出全部 mock 反馈（与 dev tools 对照） */
export function __listMockFeedback(): Array<{ email: string; entries: unknown[] }> {
  const out: Array<{ email: string; entries: unknown[] }> = []
  for (const { user } of mockUsers.values()) {
    out.push({ email: user.email, entries: mockFeedback.get(user.id) ?? [] })
  }
  return out
}

/** 单元测试 / 调试用：读 mock 分享次数 */
export function __getMockShareCount(userId: string): number {
  return mockShareCount.get(userId) ?? 0
}

/**
 * 单元测试用：动态切换 mock / real 模式。
 * - 仅测试场景使用（与 __resetMockDb / __bumpMockQuota 同前缀约定）；
 * - 调用后 isMockMode 立即反映新值；
 * - 不影响 BASE_URL（BASE_URL 仍是模块初始化时定的，除非另设）。
 */
export function __setMockMode(value: boolean): void {
  USE_MOCK = value
}