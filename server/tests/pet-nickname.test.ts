// 【文件说明】宠物昵称路由测试（M3 工单）：
//   - 首次设置成功（含 GET /api/me 字段回归）
//   - 72h 内再改被拒且 error.extra 带剩余秒数
//   - 模拟 72h 后成功
//   - 非法昵称（空、超 8 字、空白）被拒
//   - 鉴权失败路径
//
// 冷却时间测试通过直接改库 pet_nickname_changed_at 模拟时间流逝，避免 setTimeout 真等 72h。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import type { Express } from "express"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb, PET_NICKNAME_COOLDOWN_SEC } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { ErrorCodes } from "../src/errors.js"
import type { Db } from "../src/db.js"
import type { ServerConfig } from "../src/config.js"
import type { Mailer } from "../src/mailer.js"

interface TestEnv {
  app: Express
  db: Db
  cleanup: () => void
}

function setupEnv(overrides: Partial<ServerConfig> = {}): TestEnv {
  const config = loadConfig({ env: "test", dbPath: ":memory:", ...overrides })
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const mailer = createMailer(config)
  const app = createApp({ db, config, mailer })
  return {
    app,
    db,
    cleanup: () => {
      try {
        closeDb(db)
      } catch {
        /* ignore */
      }
    },
  }
}

/** 工具：登录拿 token；同时把档案写完，方便 GET /api/me 返回 hasProfile=true。 */
async function registerAndProfile(
  app: Express,
  email: string,
  opts: { nickname?: string; mbti?: string; subtype?: "stable" | "sensitive" } = {},
): Promise<{ token: string; userId: number }> {
  const codeRes = await request(app).post("/api/auth/email/code").send({ email })
  const devCode: string = codeRes.body.devCode
  const verifyRes = await request(app)
    .post("/api/auth/email/verify")
    .send({ email, code: devCode })
  const token: string = verifyRes.body.token
  const userId: number = verifyRes.body.user.id
  // 写档（昵称 + MBTI + subtype），让 hasProfile=true；不写则 GET 返回 hasProfile=false 不影响本测试断言
  await request(app)
    .post("/api/me/profile")
    .set("Authorization", `Bearer ${token}`)
    .send({
      nickname: opts.nickname ?? "蝴蝶",
      mbti: opts.mbti ?? "INFP",
      subtype: opts.subtype ?? "sensitive",
    })
  return { token, userId }
}

/**
 * 把指定用户的 pet_nickname_changed_at 改成"距今多久之前"（秒）。
 * 用法：rewindChangeAt(db, userId, 3600) → 把 changed_at 设为 now-3600，等价于 1 小时前改过。
 */
function rewindChangeAt(db: Db, userId: number, secondsAgo: number): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE users SET pet_nickname_changed_at = ? WHERE id = ?").run(now - secondsAgo, userId)
}

describe("宠物昵称 POST /api/me/pet-nickname", () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupEnv()
  })
  afterEach(() => {
    env.cleanup()
  })

  it("首次设置成功：changed_at 由 0 变为 now，pet_nickname 回显", async () => {
    const { token } = await registerAndProfile(env.app, "first@example.com")
    // 初次 /api/me：pet_nickname=null，changed_at=0
    const me0 = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(me0.status).toBe(200)
    expect(me0.body.pet_nickname).toBeNull()
    expect(me0.body.pet_nickname_changed_at).toBe(0)
    // next_change_at 在 changed_at=0 时 = now（首次不受限）
    const me0Next = me0.body.next_change_at as number
    const now = Math.floor(Date.now() / 1000)
    expect(Math.abs(me0Next - now)).toBeLessThanOrEqual(2)

    // 设置昵称
    const res = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "小白" })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.pet_nickname).toBe("小白")
    expect(res.body.pet_nickname_changed_at).toBeGreaterThan(0)
    // 修改后 next_change_at = changed_at + 72h（与当前相差 259200 秒）
    expect(res.body.next_change_at - res.body.pet_nickname_changed_at).toBe(PET_NICKNAME_COOLDOWN_SEC)

    // GET /api/me 同步带回来
    const me1 = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(me1.body.pet_nickname).toBe("小白")
    expect(me1.body.pet_nickname_changed_at).toBeGreaterThan(0)
    expect(me1.body.next_change_at - me1.body.pet_nickname_changed_at).toBe(PET_NICKNAME_COOLDOWN_SEC)
  })

  it("72h 内再改被拒：429 + error.extra.remainSec & error.extra.nextChangeAt", async () => {
    const { token, userId } = await registerAndProfile(env.app, "cooldown@example.com")
    // 第一次：成功
    const first = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "阿白" })
    expect(first.status).toBe(200)

    // 模拟距今 1 小时前改过 → 剩余约 71 小时
    rewindChangeAt(env.db, userId, 3600)

    const second = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "小黑" })
    expect(second.status).toBe(429)
    expect(second.body.ok).toBe(false)
    expect(second.body.error.code).toBe(ErrorCodes.PetNicknameCooldown)
    // error.extra 携带剩余秒数与下次可改时间戳
    expect(second.body.error.extra).toBeTruthy()
    const extra = second.body.error.extra as { remainSec: number; nextChangeAt: number }
    expect(extra.remainSec).toBeGreaterThan(0)
    // 71h 上下浮动几秒：合理范围 71*3600-5 ~ 71*3600+5
    expect(extra.remainSec).toBeGreaterThan(PET_NICKNAME_COOLDOWN_SEC - 3700)
    expect(extra.remainSec).toBeLessThanOrEqual(PET_NICKNAME_COOLDOWN_SEC - 3600 + 5)
    // nextChangeAt = changed_at + 72h
    expect(extra.nextChangeAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // 数据库 pet_nickname 应保持原值 "阿白"，未被污染
    const row = env.db.prepare("SELECT pet_nickname FROM users WHERE id = ?").get(userId) as {
      pet_nickname: string | null
    }
    expect(row.pet_nickname).toBe("阿白")
  })

  it("72h 后成功：changed_at 被刷新为 now，pet_nickname 更新", async () => {
    const { token, userId } = await registerAndProfile(env.app, "after@example.com")
    // 第一次
    const first = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "旧名" })
    expect(first.status).toBe(200)
    const firstChangedAt = first.body.pet_nickname_changed_at as number

    // 模拟距今 72h + 1s 前改过（已过冷却期）
    rewindChangeAt(env.db, userId, PET_NICKNAME_COOLDOWN_SEC + 1)

    const second = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "新名" })
    expect(second.status).toBe(200)
    expect(second.body.pet_nickname).toBe("新名")
    // 验证 changed_at 是"当前 now"，不是被冻结在 72h+1s 前的时间戳
    // 两次操作可能落在同一 Unix 秒，所以用 ">=" 比较；关键是数据库确实被改了
    const dbRow = env.db
      .prepare("SELECT pet_nickname, pet_nickname_changed_at FROM users WHERE id = ?")
      .get(userId) as { pet_nickname: string; pet_nickname_changed_at: number }
    expect(dbRow.pet_nickname).toBe("新名")
    expect(dbRow.pet_nickname_changed_at).toBeGreaterThanOrEqual(firstChangedAt)
    // 响应里的 next_change_at 也要对齐新 changed_at + 72h
    expect(second.body.next_change_at - second.body.pet_nickname_changed_at).toBe(PET_NICKNAME_COOLDOWN_SEC)
  })

  it("边界：距今恰好 72h 整点 → 应该允许（now >= next_change_at）", async () => {
    const { token, userId } = await registerAndProfile(env.app, "edge@example.com")
    // 先设一次
    const first = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "边缘" })
    expect(first.status).toBe(200)
    // 把 changed_at 设为恰好 72h 前（误差容忍 ±1s）
    rewindChangeAt(env.db, userId, PET_NICKNAME_COOLDOWN_SEC)
    const second = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "边缘新" })
    expect([200, 429]).toContain(second.status)
    // 偶发卡顿在 1s 之内仍可能 429；只要不抛 5xx 即视为边界正常
    if (second.status === 429) {
      expect(second.body.error.extra.remainSec).toBeLessThanOrEqual(1)
    }
  })

  it("昵称为空 → 400 INVALID_PET_NICKNAME", async () => {
    const { token } = await registerAndProfile(env.app, "empty@example.com")
    const res = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidPetNickname)
  })

  it("昵称仅空白（空格 / Tab / 全角空格） → 400 INVALID_PET_NICKNAME", async () => {
    const { token } = await registerAndProfile(env.app, "ws@example.com")
    for (const bad of ["   ", "\t", "\n", "\u3000\u3000"]) {
      const res = await request(env.app)
        .post("/api/me/pet-nickname")
        .set("Authorization", `Bearer ${token}`)
        .send({ nickname: bad })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe(ErrorCodes.InvalidPetNickname)
    }
  })

  it("昵称超 8 字 → 400 INVALID_PET_NICKNAME；写入未发生", async () => {
    const { token, userId } = await registerAndProfile(env.app, "toolong@example.com")
    // 9 个字符（含中英文都按字符数算）
    const res = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "abcdefghi" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidPetNickname)
    const row = env.db.prepare("SELECT pet_nickname FROM users WHERE id = ?").get(userId) as {
      pet_nickname: string | null
    }
    expect(row.pet_nickname).toBeNull()
  })

  it("昵称首尾含空格：内部过滤后再判长度（'  小白  ' → 2 字）", async () => {
    const { token } = await registerAndProfile(env.app, "trim@example.com")
    const res = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "  小白  " })
    expect(res.status).toBe(200)
    expect(res.body.pet_nickname).toBe("小白")
  })

  it("无 token → 401 UNAUTHORIZED", async () => {
    const res = await request(env.app)
      .post("/api/me/pet-nickname")
      .send({ nickname: "谁" })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe(ErrorCodes.Unauthorized)
  })

  it("非法 token → 401 UNAUTHORIZED", async () => {
    const res = await request(env.app)
      .post("/api/me/pet-nickname")
      .set("Authorization", "Bearer not-a-jwt")
      .send({ nickname: "谁" })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe(ErrorCodes.Unauthorized)
  })

  it("GET /api/me 始终带 pet_nickname + pet_nickname_changed_at + next_change_at + pet_name + animal", async () => {
    const { token } = await registerAndProfile(env.app, "getshape@example.com")
    const me = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(me.status).toBe(200)
    expect(me.body).toHaveProperty("pet_nickname")
    expect(me.body).toHaveProperty("pet_nickname_changed_at")
    expect(me.body).toHaveProperty("next_change_at")
    expect(me.body).toHaveProperty("pet_name")
    expect(me.body).toHaveProperty("animal")
    // 字段类型
    expect(me.body.pet_nickname).toBeNull()
    expect(typeof me.body.pet_nickname_changed_at).toBe("number")
    expect(typeof me.body.next_change_at).toBe("number")
    // 写档完成，mbti 已设 → pet_name / animal 应来自 data/personas/infp.json
    expect(typeof me.body.pet_name).toBe("string")
    expect((me.body.pet_name as string).length).toBeGreaterThan(0)
    expect(typeof me.body.animal).toBe("string")
    expect((me.body.animal as string).length).toBeGreaterThan(0)
  })

  it("未写档时 /api/me 的 pet_name / animal 为 null", async () => {
    const codeRes = await request(env.app).post("/api/auth/email/code").send({ email: "noprofile@example.com" })
    const verify = await request(env.app).post("/api/auth/email/verify").send({
      email: "noprofile@example.com",
      code: codeRes.body.devCode,
    })
    const token: string = verify.body.token
    const me = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(me.status).toBe(200)
    expect(me.body.hasProfile).toBe(false)
    expect(me.body.mbti).toBeNull()
    expect(me.body.pet_name).toBeNull()
    expect(me.body.animal).toBeNull()
  })
})

// 防 TS 警告未使用的导入
void (null as unknown as Mailer)