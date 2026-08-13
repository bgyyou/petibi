// 【文件说明】意图过滤单元测试：覆盖"越界命中"/"闲聊识别"/"正常问题不命中"三类判定
import { describe, expect, it } from "vitest"
import { checkIntent, isChitchat } from "../src/intent-filter.js"
import type { IntentFilterFile } from "../src/types.js"

// 测试夹具：与 scripts/fixtures/intent-filter-fixture.json 同步
const FILTER: IntentFilterFile = {
  rules: [
    { category: "code", keywords: ["写代码", "python", "bug", "编程", "代码"], action: "refuse" },
    { category: "homework", keywords: ["做题", "数学题", "物理题"], action: "refuse" },
    { category: "generate", keywords: ["生成图片", "画一张", "做个ppt"], action: "refuse" },
    { category: "web", keywords: ["天气", "股价", "新闻"], action: "refuse" },
    { category: "roleplay", keywords: ["扮演律师", "扮演医生"], action: "refuse" },
  ],
  rag_skip_patterns: ["你好", "早上好", "晚安", "谢谢", "哈哈"],
}

describe("intent filter", () => {
  it("命中 code 类越界", () => {
    const hit = checkIntent("帮我用 python 写个爬虫", FILTER)
    expect(hit).not.toBeNull()
    expect(hit?.category).toBe("code")
    expect(hit?.matched_keyword).toBe("python")
  })

  it("命中 homework 类越界", () => {
    expect(checkIntent("帮我解个数学题", FILTER)?.category).toBe("homework")
  })

  it("命中 generate 类越界", () => {
    expect(checkIntent("帮我画一张 logo", FILTER)?.category).toBe("generate")
  })

  it("命中 web 类越界", () => {
    expect(checkIntent("今天天气怎么样", FILTER)?.category).toBe("web")
  })

  it("命中 roleplay 类越界", () => {
    expect(checkIntent("你扮演律师帮我看看", FILTER)?.category).toBe("roleplay")
  })

  it("不命中：正常问题", () => {
    expect(checkIntent("明天要当众演讲好紧张", FILTER)).toBeNull()
    expect(checkIntent("我该不该换工作", FILTER)).toBeNull()
  })

  it("大小写不敏感", () => {
    // 大写关键词如 PYTHON 也能命中（虽然中文语料里少见，但保险起见支持）
    const hit = checkIntent("看看 PYTHON 的代码", FILTER)
    expect(hit?.category).toBe("code")
  })

  it("闲聊识别：'你好' 命中 rag_skip_patterns", () => {
    expect(isChitchat("你好", FILTER)).toBe(true)
    expect(isChitchat("哈哈", FILTER)).toBe(true)
    expect(isChitchat("你好,今天心情不错", FILTER)).toBe(true)
  })

  it("闲聊识别：'我该怎么办' 不命中", () => {
    expect(isChitchat("我该怎么办", FILTER)).toBe(false)
  })
})