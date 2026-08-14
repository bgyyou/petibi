// 【文件说明】人格速查卡路径解析测试（M4 打包路径修复工单）。
//
// 背景：owner 实测安装版「我的」页动物显示"未知"、宠物昵称显示"伙伴"——都是兜底文案。
// 根因：server 被 esbuild 打成 CJS 单文件 bundle 后 import.meta.url 为空串，
// personas.ts 里的 fileURLToPath(import.meta.url) 推算不出 data/personas 目录，
// loadPersonaCard 抛错 → routes/me.ts 走了"伙伴/未知"兜底。
//
// 本测试钉死修复后的路径解析契约（与 publicDirOverride / postersDirOverride 同一套模式）：
//   1. resolvePersonasDir 优先级：显式参数 > PETIBI_PERSONAS_DIR 环境变量 > import.meta.url 推算；
//   2. 注入正确目录 → GET /api/me 返回真实动物名（ENTP = 狐狸），不是兜底"未知"；
//   3. 注入错误目录 → 仍是 200 + 兜底文案（不能 500 阻塞主链路），证明注入路径真的被使用。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import type { Express } from "express"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { loadPersonaCard, resolvePersonasDir } from "../src/personas.js"
import type { Db } from "../src/db.js"

/** 仓库根下的真实人格资产目录（server/tests → server → 仓库根） */
const REPO_PERSONAS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "personas",
)

interface TestEnv {
  app: Express
  db: Db
  cleanup: () => void
}

/** 起一个注入了指定 personasDir 的 app（personasDir=undefined 即不注入，走 env / 推算） */
function setupEnv(personasDir?: string): TestEnv {
  const config = loadConfig({ env: "test", dbPath: ":memory:" })
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const mailer = createMailer(config)
  const app = createApp({ db, config, mailer, personasDirOverride: personasDir })
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

/** 注册 + 写档成 ENTP，返回 token */
async function registerEntp(app: Express, email: string): Promise<string> {
  const codeRes = await request(app).post("/api/auth/email/code").send({ email })
  const verifyRes = await request(app)
    .post("/api/auth/email/verify")
    .send({ email, code: codeRes.body.devCode })
  const token: string = verifyRes.body.token
  await request(app)
    .post("/api/me/profile")
    .set("Authorization", `Bearer ${token}`)
    .send({ nickname: "阿狐", mbti: "ENTP", subtype: "stable" })
  return token
}

describe("resolvePersonasDir 路径优先级", () => {
  const ENV_KEY = "PETIBI_PERSONAS_DIR"
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = saved
  })

  it("显式参数优先级最高（内嵌打包场景：主进程注入 resources/data/personas）", () => {
    process.env[ENV_KEY] = join("C:", "from-env")
    expect(resolvePersonasDir(join("C:", "explicit"))).toBe(join("C:", "explicit"))
  })

  it("无显式参数时用 PETIBI_PERSONAS_DIR（chat 路由等没有 deps 通道的调用点靠它兜住）", () => {
    process.env[ENV_KEY] = join("C:", "from-env")
    expect(resolvePersonasDir()).toBe(join("C:", "from-env"))
  })

  it("两者都无时回落到仓库 data/personas（dev / tsx CLI / vitest 场景）", () => {
    expect(resolvePersonasDir()).toBe(REPO_PERSONAS_DIR)
  })

  it("按注入目录能读到真实速查卡：ENTP → 狐狸", () => {
    const card = loadPersonaCard("ENTP", REPO_PERSONAS_DIR)
    expect(card.animal).toBe("狐狸")
    expect(card.pet_name).toBe("狐狸")
  })
})

describe("GET /api/me 动物名（P0：打包后显示\"未知/伙伴\"回归）", () => {
  let env: TestEnv
  afterEach(() => {
    env?.cleanup()
  })

  it("注入正确 personasDir → 返回真实动物名 狐狸，而不是兜底\"未知\"", async () => {
    env = setupEnv(REPO_PERSONAS_DIR)
    const token = await registerEntp(env.app, "fox@example.com")
    const res = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.animal).toBe("狐狸")
    expect(res.body.pet_name).toBe("狐狸")
    expect(res.body.animal).not.toBe("未知")
    expect(res.body.pet_name).not.toBe("伙伴")
  })

  it("注入的目录不存在 → 200 + 兜底文案（证明注入路径确实被使用，且不 500 阻塞主链路）", async () => {
    env = setupEnv(join(REPO_PERSONAS_DIR, "__not_exists__"))
    const token = await registerEntp(env.app, "missing@example.com")
    const res = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.animal).toBe("未知")
    expect(res.body.pet_name).toBe("伙伴")
  })

  it("未写档（mbti=null）时 animal / pet_name 都是 null，不走速查卡", async () => {
    env = setupEnv(REPO_PERSONAS_DIR)
    const codeRes = await request(env.app).post("/api/auth/email/code").send({ email: "new@example.com" })
    const verifyRes = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "new@example.com", code: codeRes.body.devCode })
    const res = await request(env.app)
      .get("/api/me")
      .set("Authorization", `Bearer ${verifyRes.body.token}`)
    expect(res.status).toBe(200)
    expect(res.body.animal).toBeNull()
    expect(res.body.pet_name).toBeNull()
  })
})
