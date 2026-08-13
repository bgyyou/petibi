// 【文件说明】人格速查卡 / 拒绝模板单元测试：使用 scripts/fixtures/ 下的 fixture，
// 不触碰 data/personas/ 与 data/refusals.json 的真实生产文件。
// 路径用 import.meta.url 计算（test 文件位置 → 仓库根 → fixtures），不依赖 process.cwd()，
// 确保从 server/ 或仓库根执行 vitest 都能找到 fixture。
import { describe, expect, it } from "vitest"
import { buildSystemPrompt } from "../src/personas.js"
import { loadRefusals, pickRefusal } from "../src/refusals.js"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Personality } from "../src/types.js"

// 从 server/tests/personas-refusals.test.ts → server/tests/ → server/ → 仓库根 → scripts/fixtures/
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_REFUSALS = resolve(join(HERE, "..", "..", "scripts", "fixtures", "refusals-fixture.json"))

describe("refusals (fixture)", () => {
  const refusals = loadRefusals(FIXTURE_REFUSALS)

  it("pickRefusal 选择 ENTP code 类的一条", () => {
    const r = pickRefusal("ENTP", "code", refusals)
    expect(r.length).toBeGreaterThan(0)
    // fixture 模板以"代码"/"我"等开头，禁止"对不起我无法"
    expect(r.startsWith("对不起")).toBe(false)
  })

  it("pickRefusal 命中 ENTP 现有所有类别", () => {
    for (const cat of ["code", "homework", "generate", "web", "roleplay"] as const) {
      const r = pickRefusal("ENTP", cat, refusals)
      expect(r.length).toBeGreaterThan(0)
    }
  })

  it("pickRefusal 跨人格兜底：非 ENTP 人格仍能取到", () => {
    const r = pickRefusal("INTJ", "code", refusals)
    expect(r.length).toBeGreaterThan(0)
  })

  it("pickRefusal 未知类别走兜底文案", () => {
    const r = pickRefusal("INTJ", "nonexistent", refusals)
    expect(r).toContain("不在我的世界里")
  })
})

describe("personas prompt", () => {
  it("buildSystemPrompt 使用注入卡时输出基础层 + 人格层", () => {
    const card = {
      type: "ENTP" as Personality,
      pet_name: "狐狸",
      animal: "狐狸",
      family: "analyst",
      system_prompt: "【人格】测试人格层",
      cognitive: ["Ne", "Ti"],
      style_keywords: ["幽默"],
    }
    const sys = buildSystemPrompt("ENTP", { ENTP: card })
    expect(sys).toContain("Petibi 桌宠")
    expect(sys).toContain("测试人格层")
  })

  it("buildSystemPrompt 缺卡时用兜底人格（不抛错）", () => {
    // 不注入 card，让 buildSystemPrompt 走 loadPersonaCard 路径
    // data/personas/entp.json 不一定存在，应走兜底分支
    const sys = buildSystemPrompt("ENTP")
    expect(sys.length).toBeGreaterThan(0)
    expect(sys).toContain("Petibi 桌宠")
  })
})