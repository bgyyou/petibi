// 【文件说明】社区广场 + 审核管道路由测试（M4 工单，红线 R7 核心）：
//
// 覆盖用例：
//   1. 上传海报（合法文案）→ approved，广场列表可见
//   2. 上传海报（含敏感词如"加微信"）→ rejected，广场不可见，moderation_logs 有 reject 记录
//   3. 留言（含敏感词）→ rejected，留言列表不可见，moderation_logs 有 reject 记录
//   4. 留言（合法文案）→ approved，留言列表可见
//   5. 点赞幂等：先点赞 likes=1，再点赞 likes=0
//   6. 分享计数累加：连点 3 次 share-count，count=3
//   7. 未审核通过的 poster 不可被点赞 / 留言
//   8. 鉴权：POST 类端点不带 token 必须 401；GET 公开端点不带 token 200
//
// 设计要点：
//   - 用 supertest 直接喂 createApp()，不走真实端口
//   - 用 LocalModeration（默认实现），词库读 data/sensitive-words.json
//   - 全部状态隔离在内存 SQLite（:memory:）+ ensureSchema

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import type { Express } from "express"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { ErrorCodes } from "../src/errors.js"
import type { Db } from "../src/db.js"
import type { ServerConfig } from "../src/config.js"
import type { Mailer } from "../src/mailer.js"
import { LocalModeration, type ModerationProvider } from "../src/moderation.js"

/** 1×1 透明 PNG 的 base64（用于海报上传，避免依赖外部资源） */
const TINY_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/** 测试环境：app + db + cleanup */
interface TestEnv {
  app: Express
  db: Db
  moderation: ModerationProvider
  cleanup: () => void
}

function setupEnv(overrides: Partial<ServerConfig> = {}): TestEnv {
  const config = loadConfig({ env: "test", dbPath: ":memory:", ...overrides })
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const mailer = createMailer(config)
  // 测试场景用 LocalModeration 读默认词库（与生产路径一致）
  const moderation = new LocalModeration()
  const app = createApp({ db, config, mailer, moderation })
  return {
    app,
    db,
    moderation,
    cleanup: () => {
      try {
        closeDb(db)
      } catch {
        /* ignore */
      }
    },
  }
}

/** 工具：注册 + 拿 token */
async function register(app: Express, email: string): Promise<{ token: string; userId: number }> {
  const codeRes = await request(app).post("/api/auth/email/code").send({ email })
  const verifyRes = await request(app)
    .post("/api/auth/email/verify")
    .send({ email, code: codeRes.body.devCode })
  return { token: verifyRes.body.token, userId: verifyRes.body.user.id }
}

/** 工具：上传一张海报（默认会审核通过） */
async function uploadPoster(
  app: Express,
  token: string,
  opts: { question?: string; answer?: string; imageBase64?: string } = {},
): Promise<{ status: number; body: { ok: boolean; poster_id: number; status: string; reason?: string } }> {
  const res = await request(app)
    .post("/api/posters")
    .set("Authorization", `Bearer ${token}`)
    .send({
      image_base64: opts.imageBase64 ?? TINY_PNG_BASE64,
      persona_type: "INFP",
      question_excerpt: opts.question ?? "今天心情有点低落怎么办？",
      answer_excerpt: opts.answer ?? "抱抱你～试着做一件让自己开心的小事吧。",
    })
  return res as unknown as { status: number; body: { ok: boolean; poster_id: number; status: string; reason?: string } }
}

describe("M4 社区广场 + 审核管道", () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupEnv()
  })
  afterEach(() => {
    env.cleanup()
  })

  // ---------- 1. 上传→approved→广场可见 ----------
  it("合法文案上传：status=approved，广场列表立即可见，likes 默认 0", async () => {
    const { token } = await register(env.app, "good@example.com")
    const up = await uploadPoster(env.app, token)
    expect(up.status).toBe(200)
    expect(up.body.ok).toBe(true)
    expect(up.body.status).toBe("approved")
    const posterId = up.body.poster_id

    // 广场列表
    const list = await request(env.app).get("/api/posters")
    expect(list.status).toBe(200)
    expect(list.body.items).toBeInstanceOf(Array)
    const ids = (list.body.items as Array<{ id: number }>).map((x) => x.id)
    expect(ids).toContain(posterId)
    const item = (list.body.items as Array<{ id: number; likes: number }>).find((x) => x.id === posterId)
    expect(item?.likes).toBe(0)
  })

  // ---------- 2. 含敏感词海报：rejected + 广场不可见 + 日志留痕 ----------
  it("海报文案含敏感词（'加微信'）：status=rejected，广场不可见，moderation_logs 有 reject 记录", async () => {
    const { token, userId } = await register(env.app, "bad-poster@example.com")
    const up = await uploadPoster(env.app, token, {
      question: "加微信领优惠",
      answer: "正常回答内容",
    })
    expect(up.status).toBe(200)
    expect(up.body.status).toBe("rejected")
    expect(up.body.reason).toMatch(/本地敏感词库/)
    const posterId = up.body.poster_id

    // 广场列表不应包含
    const list = await request(env.app).get("/api/posters")
    const ids = (list.body.items as Array<{ id: number }>).map((x) => x.id)
    expect(ids).not.toContain(posterId)

    // moderation_logs 必须有 reject 记录
    const logs = env.db
      .prepare(
        `SELECT content_type, content_id, user_id, provider, decision, reason
           FROM moderation_logs WHERE content_type='poster' AND content_id=?`,
      )
      .get(posterId) as
      | {
          content_type: string
          content_id: number
          user_id: number
          provider: string
          decision: string
          reason: string
        }
      | undefined
    expect(logs).toBeTruthy()
    expect(logs!.decision).toBe("reject")
    expect(logs!.provider).toBe("local")
    expect(logs!.user_id).toBe(userId)
    expect(logs!.reason).toMatch(/本地敏感词库/)
  })

  // ---------- 3. 留言含敏感词：rejected + 日志 ----------
  it("留言含敏感词（'加微信'）：status=rejected，留言列表不可见，moderation_logs 有 reject 记录", async () => {
    const { token } = await register(env.app, "commenter@example.com")
    // 先上传一张合法海报拿到 id
    const up = await uploadPoster(env.app, token)
    const posterId = up.body.poster_id

    const c = await request(env.app)
      .post(`/api/posters/${posterId}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "想聊更多请加微信吧" })
    expect(c.status).toBe(200)
    expect(c.body.status).toBe("rejected")
    expect(c.body.reason).toMatch(/本地敏感词库/)

    // 留言列表不可见（只有 approved）
    const list = await request(env.app).get(`/api/posters/${posterId}/comments`)
    expect(list.status).toBe(200)
    expect((list.body.items as Array<unknown>).length).toBe(0)

    // 留言 moderation_logs
    const logs = env.db
      .prepare(
        `SELECT decision, provider FROM moderation_logs WHERE content_type='comment' AND content_id=?`,
      )
      .get(c.body.comment_id) as { decision: string; provider: string } | undefined
    expect(logs?.decision).toBe("reject")
    expect(logs?.provider).toBe("local")
  })

  // ---------- 4. 留言合法：approved + 列表可见 ----------
  it("合法留言：approved，留言列表可见", async () => {
    const { token } = await register(env.app, "good-comment@example.com")
    const up = await uploadPoster(env.app, token)
    const posterId = up.body.poster_id

    const c = await request(env.app)
      .post(`/api/posters/${posterId}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "很喜欢这只小猫！" })
    expect(c.status).toBe(200)
    expect(c.body.status).toBe("approved")

    const list = await request(env.app).get(`/api/posters/${posterId}/comments`)
    expect((list.body.items as Array<{ id: number; content: string }>).length).toBe(1)
    expect((list.body.items as Array<{ content: string }>)[0]!.content).toBe("很喜欢这只小猫！")
  })

  // ---------- 5. 点赞幂等 ----------
  it("点赞幂等：第一次 likes=1 liked=true，第二次 likes=0 liked=false", async () => {
    const { token: tokenA } = await register(env.app, "liker@example.com")
    const up = await uploadPoster(env.app, tokenA)
    const posterId = up.body.poster_id

    const { token: tokenB } = await register(env.app, "liker2@example.com")
    const r1 = await request(env.app)
      .post(`/api/posters/${posterId}/like`)
      .set("Authorization", `Bearer ${tokenB}`)
    expect(r1.status).toBe(200)
    expect(r1.body.liked).toBe(true)
    expect(r1.body.likes).toBe(1)

    const r2 = await request(env.app)
      .post(`/api/posters/${posterId}/like`)
      .set("Authorization", `Bearer ${tokenB}`)
    expect(r2.status).toBe(200)
    expect(r2.body.liked).toBe(false)
    expect(r2.body.likes).toBe(0)

    // 第三次回到 liked=true
    const r3 = await request(env.app)
      .post(`/api/posters/${posterId}/like`)
      .set("Authorization", `Bearer ${tokenB}`)
    expect(r3.body.liked).toBe(true)
    expect(r3.body.likes).toBe(1)
  })

  // ---------- 6. 分享计数累加 ----------
  it("分享计数累加：连点 3 次 share-count，count=3", async () => {
    const { token } = await register(env.app, "share@example.com")
    for (let i = 1; i <= 3; i++) {
      const r = await request(env.app)
        .post("/api/me/share-count")
        .set("Authorization", `Bearer ${token}`)
      expect(r.status).toBe(200)
      expect(r.body.count).toBe(i)
    }
  })

  // ---------- 7. pending 海报不可点赞 / 留言 ----------
  it("未审核通过的海报：点赞与留言都应 404", async () => {
    const { token: tokenA } = await register(env.app, "owner@example.com")
    // 用敏感词让海报进入 rejected 状态（模拟 pending：rejected 与 pending 都不在广场）
    const up = await uploadPoster(env.app, tokenA, {
      question: "加微信优惠",
      answer: "ok",
    })
    expect(up.body.status).toBe("rejected")

    // 用另一个用户去点赞/留言
    const { token: tokenB } = await register(env.app, "user-b@example.com")
    const like = await request(env.app)
      .post(`/api/posters/${up.body.poster_id}/like`)
      .set("Authorization", `Bearer ${tokenB}`)
    expect(like.status).toBe(404)
    expect(like.body.error.code).toBe(ErrorCodes.NotFound)

    const comment = await request(env.app)
      .post(`/api/posters/${up.body.poster_id}/comments`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ content: "试试看" })
    expect(comment.status).toBe(404)

    // GET 留言列表也是 404（海报不可见）
    const list = await request(env.app).get(`/api/posters/${up.body.poster_id}/comments`)
    expect(list.status).toBe(404)
  })

  // ---------- 8. 鉴权边界 ----------
  it("鉴权边界：POST 类端点不带 token 401；GET 公开端点不带 token 200", async () => {
    // POST 上传 → 401
    const upNoAuth = await request(env.app)
      .post("/api/posters")
      .send({ image_base64: TINY_PNG_BASE64, persona_type: "INFP", question_excerpt: "q", answer_excerpt: "a" })
    expect(upNoAuth.status).toBe(401)

    // POST share-count → 401
    const shareNoAuth = await request(env.app).post("/api/me/share-count")
    expect(shareNoAuth.status).toBe(401)

    // GET 广场列表 → 200（公开）
    const list = await request(env.app).get("/api/posters")
    expect(list.status).toBe(200)
  })

  // ---------- 9. 留言超长：400 COMMENT_TOO_LONG ----------
  it("留言 >200 字：400 COMMENT_TOO_LONG", async () => {
    const { token } = await register(env.app, "long@example.com")
    const up = await uploadPoster(env.app, token)
    const posterId = up.body.poster_id

    const long = "啊".repeat(201)
    const r = await request(env.app)
      .post(`/api/posters/${posterId}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: long })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe(ErrorCodes.CommentTooLong)
    expect((r.body.error.extra as { actualLen: number }).actualLen).toBe(201)
  })

  // ---------- 10. 合规页面：/privacy /terms 返回 HTML ----------
  it("合规页面 /privacy 与 /terms 返回 HTML（200）", async () => {
    const privacy = await request(env.app).get("/privacy")
    expect(privacy.status).toBe(200)
    expect(privacy.headers["content-type"]).toMatch(/text\/html/)
    expect(privacy.text).toContain("隐私政策")

    const terms = await request(env.app).get("/terms")
    expect(terms.status).toBe(200)
    expect(terms.headers["content-type"]).toMatch(/text\/html/)
    expect(terms.text).toContain("用户协议")
  })

  // ---------- 11. 图片合法性校验 ----------
  it("image_base64 非法格式（缺 data URL 前缀）：400 INVALID_POSTER", async () => {
    const { token } = await register(env.app, "bad-img@example.com")
    const r = await request(env.app)
      .post("/api/posters")
      .set("Authorization", `Bearer ${token}`)
      .send({
        image_base64: "iVBORw0KGgoAAAANSUhEUgAA...", // 没有 data:image/...;base64, 前缀
        persona_type: "INFP",
        question_excerpt: "q",
        answer_excerpt: "a",
      })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe(ErrorCodes.InvalidPoster)
  })

  // ---------- 12. 幂等点赞：likes 表 UNIQUE 不重复计数 ----------
  it("同一用户同一海报不会重复计数（UNIQUE 约束）", async () => {
    const { token: tokenA } = await register(env.app, "u-a@example.com")
    const up = await uploadPoster(env.app, tokenA)
    const posterId = up.body.poster_id
    const { token: tokenB } = await register(env.app, "u-b@example.com")
    // 重复点击：先 +1 → -1 → +1 → -1 → +1（最终 likes=1）
    for (let i = 0; i < 5; i++) {
      await request(env.app)
        .post(`/api/posters/${posterId}/like`)
        .set("Authorization", `Bearer ${tokenB}`)
    }
    // 5 次点击，奇数次 → likes=1；likes 表只有 1 行
    const likesRowCount = env.db
      .prepare(`SELECT COUNT(*) as n FROM likes WHERE poster_id=?`)
      .get(posterId) as { n: number }
    expect(likesRowCount.n).toBe(1)
    const final = env.db
      .prepare(`SELECT likes FROM posters WHERE id=?`)
      .get(posterId) as { likes: number }
    expect(final.likes).toBe(1)
  })
})

// 防 TS 警告未使用的导入
void (null as unknown as Mailer)
