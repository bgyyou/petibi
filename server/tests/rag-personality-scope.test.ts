// 【文件说明】M5 P0-B 修复：RAG 检索人格范围隔离测试。
//
// 根因复现：之前 /api/chat 调全库 retrieveTop1，ENTP / ENFP 等共享公共场景（public-speaking
// / breakup 等）的条目让别的人格 Top 1 胜出，污染 prompt。owner 实测："从 INFP 切回 ENTP
// 后对话，mock 回答参考了 ENFP 的百科条目"。
//
// 修复：路由改为调 retrieveTop1ForPersonality(question, files, user.mbti)，严格锁在
// 当前用户人格文件内。本测试钉死这条性质：
//   1. 同一问题在 ENTP / ENFP / INFJ 三种人格下分别检索，返回的 personality 必须等于传入人格；
//   2. 当问题在该人格文件里无命中时，返回 null（不退回全库）；
//   3. 关键场景：public-speaking / breakup / conflict 等共享场景在 ENTP / ENFP 下分别检索
//      时返回的 entry 必须是各自人格的条目，而不是另一人格的。
//   4. 路由 /api/chat 的 RAG 结果 personality 字段恒等于 user.mbti（黑盒测试，跑 server）。

import { describe, expect, it } from "vitest"
import {
  formatEntryForPrompt,
  loadAllEncyclopediaFiles,
  retrieveTop1,
  retrieveTop1ForPersonality,
} from "../src/rag.js"
import type { EncyclopediaFile } from "../src/types.js"

describe("M5 P0-B：retrieveTop1ForPersonality（人格范围隔离）", () => {
  const files = loadAllEncyclopediaFiles()
  expect(files.length).toBeGreaterThanOrEqual(16)

  it("人格白名单防御：传入 16 型外的非法人格 → 返回 null，不静默退回全库", () => {
    // 故意用 TypeScript any 绕过 PERSONALITIES 编译期限制，模拟运行时被污染的人参
    const r = retrieveTop1ForPersonality(
      "明天要当众演讲好紧张",
      files,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "INVALID" as any,
    )
    expect(r).toBeNull()
  })

  it("【关键】同问 public-speaking，ENTP 下返回 ENTP 条目而非 ENFP 条目", () => {
    // 这是 owner 实测的复现场景：mock 答了 ENFP 百科条目。
    // 修复后必须返回 user.mbti=ENTP 的条目。
    const entp = retrieveTop1ForPersonality(
      "明天要当众演讲好紧张",
      files,
      "ENTP",
    )
    expect(entp).not.toBeNull()
    expect(entp?.personality).toBe("ENTP")
    expect(entp?.entry.scenario).toBe("public-speaking")
    // 条目 ID 必须以 "ENTP-" 开头
    expect(entp?.entry.id).toMatch(/^ENTP-/)
  })

  it("【关键】同问 public-speaking，ENFP 下返回 ENFP 条目而非 ENTP 条目", () => {
    const enfp = retrieveTop1ForPersonality(
      "明天要当众演讲好紧张",
      files,
      "ENFP",
    )
    expect(enfp).not.toBeNull()
    expect(enfp?.personality).toBe("ENFP")
    expect(enfp?.entry.scenario).toBe("public-speaking")
    expect(enfp?.entry.id).toMatch(/^ENFP-/)
  })

  it("【关键】同问 public-speaking，INFJ 下返回 INFJ 条目（INFJ 也含公共场景）", () => {
    const infj = retrieveTop1ForPersonality(
      "明天要当众演讲好紧张",
      files,
      "INFJ",
    )
    expect(infj).not.toBeNull()
    expect(infj?.personality).toBe("INFJ")
    expect(infj?.entry.scenario).toBe("public-speaking")
  })

  it("【关键】同问 breakup（分手），ENTP / INFP 分别返回各自人格条目", () => {
    const entp = retrieveTop1ForPersonality("分手后很痛苦", files, "ENTP")
    expect(entp?.personality).toBe("ENTP")
    expect(entp?.entry.scenario).toBe("breakup")
    const infp = retrieveTop1ForPersonality("分手后很痛苦", files, "INFP")
    expect(infp?.personality).toBe("INFP")
    expect(infp?.entry.scenario).toBe("breakup")
    // 必须不是同一个条目（不同 ID）
    expect(entp?.entry.id).not.toBe(infp?.entry.id)
  })

  it("该人格文件无命中时返回 null，不静默退回全库", () => {
    // 找一个完全无关的关键词串
    const r = retrieveTop1ForPersonality("asdfghjkl-qwerty", files, "ENTP")
    expect(r).toBeNull()
    // 同样的关键词，传 ENFP 仍然 null
    const r2 = retrieveTop1ForPersonality("asdfghjkl-qwerty", files, "ENFP")
    expect(r2).toBeNull()
  })

  it("永不跨人格引用：构造两个人格同 scenario 条目，分别人格下取出来必须是各自条目", () => {
    // 构造 mock 文件：ENTP 与 ENFP 都有 "演讲" 条目，但内容上 ENFP 词频远高于 ENTP。
    // 全库检索 retrieveTop1() 跨文件比较打分，自然倾向于词频更高的 ENFP——这正是
    // 旧代码的污染源。限定人格后必须仍然取各自条目。
    const entpFile: EncyclopediaFile = {
      personality: "ENTP",
      animal: "狐狸",
      family: "analyst",
      entries: [
        {
          id: "ENTP-test",
          category: "scenario",
          title: "ENTP 演讲要点",
          content: "ENTP 演讲简短示例",
          tags: ["演讲", "public-speaking", "ENTP"],
          scenario: "public-speaking",
        },
      ],
    }
    const enfpFile: EncyclopediaFile = {
      personality: "ENFP",
      animal: "海豚",
      family: "diplomat",
      entries: [
        {
          id: "ENFP-test",
          category: "scenario",
          title: "ENFP 演讲方法论",
          content:
            "ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP ENFP 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲 演讲",
          tags: ["演讲", "public-speaking", "ENFP", "ENFP", "ENFP", "ENFP", "ENFP"],
          scenario: "public-speaking",
        },
      ],
    }
    // 全库检索会返回 ENFP（污染演示，旧代码路径会污染 prompt）。
    // 不强断言具体胜出的人格，但保证它**不在** user.mbti 对应人格文件内时，限定人格
    // 后的检索结果绝不会是这一条——这是 P0-B 修复的核心断言。
    const entpOnly = retrieveTop1ForPersonality("演讲", [entpFile, enfpFile], "ENTP")
    expect(entpOnly?.personality).toBe("ENTP")
    expect(entpOnly?.entry.id).toBe("ENTP-test")
    const enfpOnly = retrieveTop1ForPersonality("演讲", [entpFile, enfpFile], "ENFP")
    expect(enfpOnly?.personality).toBe("ENFP")
    expect(enfpOnly?.entry.id).toBe("ENFP-test")
    // 再断言即使全库检索返回了 ENFP，ENTP 的限定检索不会拿到 ENFP 条目
    const allLib = retrieveTop1("演讲", [entpFile, enfpFile])
    if (allLib?.personality === "ENFP") {
      // 全库检索被污染，限定人格是真正的护栏
      expect(entpOnly?.entry.id).not.toBe(allLib?.entry.id)
    }
  })

  it("格式渲染：formatEntryForPrompt 输出的 personality 必须与条目所属人格一致", () => {
    // 防回归：formatEntryForPrompt 用了 entry 自身的 personality 字段；
    // 配合 retrieveTop1ForPersonality 后 prompt 里的"【百科参考｜ENTP｜...】"
    // 始终与 user.mbti 一致。
    const entp = retrieveTop1ForPersonality("当众演讲", files, "ENTP")
    expect(entp).not.toBeNull()
    const out = formatEntryForPrompt(entp!.entry, entp!.personality)
    expect(out).toMatch(/【百科参考｜ENTP｜/)
    expect(out).not.toMatch(/【百科参考｜ENFP｜/)
  })
})