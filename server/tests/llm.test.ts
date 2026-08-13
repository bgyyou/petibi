// 【文件说明】LLM 模块测试：覆盖 mock 流式 + chunk 切片行为
import { describe, expect, it } from "vitest"
import { buildMessages, isMockMode, streamMock, streamLlm } from "../src/llm.js"

describe("LLM client", () => {
  it("buildMessages 输出 system + user 两条", () => {
    const msgs = buildMessages({ system: "sys", user: "usr" })
    expect(msgs.length).toBe(2)
    expect(msgs[0]?.role).toBe("system")
    expect(msgs[1]?.role).toBe("user")
  })

  it("isMockMode：无 key 时 true", () => {
    expect(isMockMode(undefined)).toBe(true)
    expect(isMockMode("")).toBe(true)
    expect(isMockMode("sk-test")).toBe(false)
    expect(isMockMode(undefined, true)).toBe(true)
  })

  it("streamMock 至少产出 1 个 delta + 1 个 done", async () => {
    const collected: string[] = []
    let doneCount = 0
    for await (const c of streamMock({ system: "s", user: "紧张" })) {
      if (c.done) {
        doneCount++
      } else if (c.delta) {
        collected.push(c.delta)
      }
    }
    expect(collected.length).toBeGreaterThan(0)
    expect(doneCount).toBeGreaterThanOrEqual(1)
  })

  it("streamLlm 在无 key 时走 mock（forceMock 未设）", async () => {
    let done = false
    let totalDelta = ""
    for await (const c of streamLlm({ system: "s", user: "测试" }, {})) {
      if (c.done) done = true
      else totalDelta += c.delta
    }
    expect(done).toBe(true)
    expect(totalDelta).toContain("mock")
  })
})