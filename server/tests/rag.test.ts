// 【文件说明】RAG 检索测试：基于真实 data/encyclopedia 验证 Top 1 命中预期条目
import { describe, expect, it } from "vitest"
import {
  formatEntryForPrompt,
  loadAllEncyclopediaFiles,
  retrieveTop1,
} from "../src/rag.js"
import type { EncyclopediaEntry, EncyclopediaFile } from "../src/types.js"

describe("RAG retrieval", () => {
  const files = loadAllEncyclopediaFiles()
  // 至少应有 16 个人格文件
  expect(files.length).toBeGreaterThanOrEqual(16)

  it("问 '明天要当众演讲好紧张' → 命中 ENTP public-speaking 场景", () => {
    const top = retrieveTop1("明天要当众演讲好紧张", files)
    expect(top).not.toBeNull()
    // 期望条目的 scenario=public-speaking
    expect(top?.entry.scenario).toBe("public-speaking")
  })

  it("问 '分手后很痛苦' → 命中 breakup 场景", () => {
    const top = retrieveTop1("分手后很痛苦", files)
    expect(top).not.toBeNull()
    expect(top?.entry.scenario).toBe("breakup")
  })

  it("问完全无关的字符 → 返回 null", () => {
    const top = retrieveTop1("asdfghjkl-qwerty", files)
    expect(top).toBeNull()
  })

  it("formatEntryForPrompt 输出含 ID/分类/正文", () => {
    const fake: EncyclopediaEntry = {
      id: "TEST-001",
      category: "trait",
      title: "测试条目",
      content: "测试内容正文",
      tags: ["a", "b"],
      scenario: "public-speaking",
    }
    const file = {
      personality: "ENTP",
      animal: "狐狸",
      family: "analyst",
      entries: [fake],
    } as unknown as EncyclopediaFile
    const out = formatEntryForPrompt(fake, "ENTP")
    expect(out).toContain("ENTP")
    expect(out).toContain("测试条目")
    expect(out).toContain("测试内容正文")
    expect(out).toContain("public-speaking")
    // 防止误用未引用变量
    void file
  })
})