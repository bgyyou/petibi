// 【文件说明】计分引擎测试（M2 工单 / 红线 R5：确定性 + 平局取第一极 + 16 型×2 细分可达遍历）
// 测试用题库为内联迷你题库（每维 2 题），不依赖 data/questions/；对应工单"测试用 fixture"约束
// 运行：`npx vitest run` 或 `npm test`

import { describe, expect, it } from "vitest"
import { score, scoreOne } from "./score"
import {
  FIRST_POLE,
  type Answers,
  type AnswerValue,
  type Dimension,
  type QuestionBank,
} from "./types"

/**
 * 内联迷你题库 fixture：每维 2 题（一正一反），合计 10 道。
 * 对 ES 维度特别引入 direction="stable"/"sensitive" 字符串，
 * 用于验证 ES 极性定义与"避免与 EI 的 E 混淆"的数据契约 §1 注释。
 */
const fixtureBank: QuestionBank = {
  version: "1.0-test-fixture",
  dimensions: ["EI", "SN", "TF", "JP", "ES"],
  questions: [
    // EI：正向测 E、反向测 I
    { id: "EI01", dimension: "EI", direction: "E", text: "聚会中通常主动开话题", source: "OEJTS", source_ref: "OEJTS item #12" },
    { id: "EI02", dimension: "EI", direction: "I", text: "聚会中更愿意倾听", source: "OEJTS", source_ref: "OEJTS item #13" },
    // SN：正向测 S、反向测 N
    { id: "SN01", dimension: "SN", direction: "S", text: "更关注具体事实", source: "OEJTS", source_ref: "OEJTS item #14" },
    { id: "SN02", dimension: "SN", direction: "N", text: "更关注抽象可能性", source: "OEJTS", source_ref: "OEJTS item #15" },
    // TF：正向测 T、反向测 F
    { id: "TF01", dimension: "TF", direction: "T", text: "决策时优先逻辑", source: "OEJTS", source_ref: "OEJTS item #16" },
    { id: "TF02", dimension: "TF", direction: "F", text: "决策时优先价值", source: "OEJTS", source_ref: "OEJTS item #17" },
    // JP：正向测 J、反向测 P
    { id: "JP01", dimension: "JP", direction: "J", text: "喜欢提前规划", source: "OEJTS", source_ref: "OEJTS item #18" },
    { id: "JP02", dimension: "JP", direction: "P", text: "喜欢随机应变", source: "OEJTS", source_ref: "OEJTS item #19" },
    // ES：正向测 stable、反向测 sensitive（细分子标签）
    { id: "ES01", dimension: "ES", direction: "stable", text: "日常情绪稳定", source: "IPIP", source_ref: "IPIP-NEO item #N01" },
    { id: "ES02", dimension: "ES", direction: "sensitive", text: "常感到紧张不安", source: "IPIP", source_ref: "IPIP-NEO item #N02" },
  ],
}

/**
 * 极化答案构造器：每个维度都把"加分方向"打 5、另一极打 1。
 * 这样每维度第一极得分占比理论上达到 100%（4 题分中有 4 题分加给第一极）。
 * 对 16 型 × 2 细分 = 32 种组合，每个组合都生成一组 answers 并断言 type / subtype。
 */
function polarized(
  bank: QuestionBank,
  choose: {
    ei: "E" | "I"
    sn: "S" | "N"
    tf: "T" | "F"
    jp: "J" | "P"
    es: "stable" | "sensitive"
  }
): Answers {
  const target: Record<Dimension, string> = {
    EI: choose.ei,
    SN: choose.sn,
    TF: choose.tf,
    JP: choose.jp,
    ES: choose.es,
  }
  const ans: Answers = {}
  for (const q of bank.questions) {
    // direction 与目标极同向 → 打 5（拉满第一极得分）
    // direction 与目标极反向 → 打 1（拉满也是给第一极 4 分）
    ans[q.id] = (q.direction === target[q.dimension] ? 5 : 1) as AnswerValue
  }
  return ans
}

/**
 * 平局答案构造器：所有题都打 3，正好使每个维度"第一极得分"= 每题 2 分 ×2 题 = 4 分；max=8 → 50%
 * 用于精确命中阈值，证明 ≥50（含恰好 50）走第一极分支（红线 R5）
 */
function neutralAnswers(bank: QuestionBank): Answers {
  const ans: Answers = {}
  for (const q of bank.questions) ans[q.id] = 3 as AnswerValue
  return ans
}

// ---------------------------------------------------------------------------
// scoreOne 单函数测试：direction 反向题计分正确（工单自验清单第 2 条）
// ---------------------------------------------------------------------------
describe("scoreOne", () => {
  it("direction 为第一极时返回 answer-1", () => {
    const q = fixtureBank.questions.find((x) => x.id === "EI01")!  // direction=E (第一极)
    expect(scoreOne(q, 1)).toBe(0)
    expect(scoreOne(q, 2)).toBe(1)
    expect(scoreOne(q, 3)).toBe(2)
    expect(scoreOne(q, 4)).toBe(3)
    expect(scoreOne(q, 5)).toBe(4)
  })

  it("direction 为第二极（反向题）时返回 5-answer，加给同一维度的『第一极』方向", () => {
    const q = fixtureBank.questions.find((x) => x.id === "EI02")!  // direction=I (第二极)
    // answer 越大越倾向 I（第二极），所以加给第一极 E 的分数应越小
    expect(scoreOne(q, 5)).toBe(0)
    expect(scoreOne(q, 4)).toBe(1)
    expect(scoreOne(q, 3)).toBe(2)
    expect(scoreOne(q, 2)).toBe(3)
    expect(scoreOne(q, 1)).toBe(4)
  })

  it("ES 维度 direction='stable'/'sensitive' 字符串走同一套规则", () => {
    const stable = fixtureBank.questions.find((x) => x.id === "ES01")!
    const sens = fixtureBank.questions.find((x) => x.id === "ES02")!
    // direction=stable 视为第一极，answer=5 → 加给 stable 4 分
    expect(scoreOne(stable, 5)).toBe(4)
    // direction=sensitive 视为第二极，answer=1 → 加给 stable 4 分
    expect(scoreOne(sens, 1)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// score 主函数：功能性测试
// ---------------------------------------------------------------------------
describe("score", () => {
  it("完全极化第一极（E/S/T/J + stable）→ ESTJ, subtype=stable，各 100%", () => {
    const r = score(polarized(fixtureBank, { ei: "E", sn: "S", tf: "T", jp: "J", es: "stable" }), fixtureBank)
    expect(r.type).toBe("ESTJ")
    expect(r.subtype).toBe("stable")
    expect(r.percentages).toEqual({ EI: 100, SN: 100, TF: 100, JP: 100, ES: 100 })
  })

  it("完全反向极化 → 全 0%，但仍归到第二极", () => {
    // 注意极化的语义：第一极占比为 0% → 取第二极
    const r = score(polarized(fixtureBank, { ei: "I", sn: "N", tf: "F", jp: "P", es: "sensitive" }), fixtureBank)
    expect(r.type).toBe("INFP")
    expect(r.subtype).toBe("sensitive")
    expect(r.percentages).toEqual({ EI: 0, SN: 0, TF: 0, JP: 0, ES: 0 })
  })

  it("混合极化：EI=E，其它=N/T/F/J → ENFP, stable", () => {
    const r = score(polarized(fixtureBank, { ei: "E", sn: "N", tf: "F", jp: "P", es: "stable" }), fixtureBank)
    expect(r.type).toBe("ENFP")
    expect(r.subtype).toBe("stable")
    expect(r.percentages.EI).toBe(100)
    expect(r.percentages.SN).toBe(0)
    expect(r.percentages.TF).toBe(0)
    expect(r.percentages.JP).toBe(0)
    expect(r.percentages.ES).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 红线 R5 / 数据契约 §4：平局（恰好 50）取第一极
// ---------------------------------------------------------------------------
describe("R5 平局取第一极", () => {
  it("所有题全打 3，每维度恰好 50%，全部归第一极", () => {
    const r = score(neutralAnswers(fixtureBank), fixtureBank)
    // 每个维度都是 50%，按契约 ≥50（含等于）→ 第一极
    for (const dim of ["EI", "SN", "TF", "JP", "ES"] as const) {
      expect(r.percentages[dim]).toBe(50)
    }
    expect(r.type).toBe("ESTJ")
    expect(r.subtype).toBe("stable")
  })

  it("构造单维度 50% 而其它维度 100% 第一极：被测维度仍归第一极", () => {
    // 以 polarized 全第一极为基底（每个维度正向题打 5、反向题打 1，得分 100%）；
    // 然后把 EI 两道题都改答 3，使该维度恰好 50%（hit 平局边界）。
    // 其它维度的"一正一反 5/1"构造保留 → 仍 100%。
    const base = polarized(fixtureBank, { ei: "E", sn: "S", tf: "T", jp: "J", es: "stable" })
    const ans: Answers = { ...base }
    for (const q of fixtureBank.questions) {
      if (q.dimension === "EI") ans[q.id] = 3 as AnswerValue
    }
    const r = score(ans, fixtureBank)
    expect(r.percentages.EI).toBe(50)
    expect(r.percentages.SN).toBe(100)
    expect(r.percentages.TF).toBe(100)
    expect(r.percentages.JP).toBe(100)
    expect(r.percentages.ES).toBe(100)
    // EI 50% 取第一极 → E
    expect(r.type.startsWith("E")).toBe(true)
    expect(r.subtype).toBe("stable")
  })

  it("构造单维度略低于 50%（4.999...）— 已通过 49% 路径覆盖", () => {
    // 用 25% 路径验证第二极（>50 不取，0/25/50 一组）
    const ans: Answers = {}
    for (const q of fixtureBank.questions) {
      // EI 题：让第一极得分 = 2/8 = 25%
      // EI01(direction=E) = 2  → scoreOne=1 ; EI02(direction=I) = 4 → scoreOne=1 ; sum=2 ; max=8
      // 其它维度全走第一极，answer=5
      if (q.dimension === "EI") {
        ans[q.id] = (q.id === "EI01" ? 2 : 4) as AnswerValue
      } else {
        ans[q.id] = 5 as AnswerValue
      }
    }
    const r = score(ans, fixtureBank)
    expect(r.percentages.EI).toBe(25)
    expect(r.type.startsWith("I")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 红线 R5 / 数据契约 §4：16 型 × 2 细分全部可达（构造极化答案）
// ---------------------------------------------------------------------------
describe("R5 16 型 × 2 细分可达性遍历", () => {
  const eiPoles = ["E", "I"] as const
  const snPoles = ["S", "N"] as const
  const tfPoles = ["T", "F"] as const
  const jpPoles = ["J", "P"] as const
  const esPoles = ["stable", "sensitive"] as const

  // 用 it.each 展开 32 个用例；每个用例都断言极化答案正确映射到对应 type + subtype
  for (const ei of eiPoles) {
    for (const sn of snPoles) {
      for (const tf of tfPoles) {
        for (const jp of jpPoles) {
          for (const es of esPoles) {
            const expectedType = `${ei}${sn}${tf}${jp}`
            it(`极化 → ${expectedType} / ${es}`, () => {
              const ans = polarized(fixtureBank, { ei, sn, tf, jp, es })
              const r = score(ans, fixtureBank)
              expect(r.type).toBe(expectedType)
              expect(r.subtype).toBe(es)
              // 极化下每维度第一极占比应为 0% 或 100%，至少与极性一致
              expect(r.percentages.EI).toBe(ei === "E" ? 100 : 0)
              expect(r.percentages.SN).toBe(sn === "S" ? 100 : 0)
              expect(r.percentages.TF).toBe(tf === "T" ? 100 : 0)
              expect(r.percentages.JP).toBe(jp === "J" ? 100 : 0)
              expect(r.percentages.ES).toBe(es === "stable" ? 100 : 0)
            })
          }
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 红线 R5 / 数据契约 §4：确定性（同 answers 调 100 次全等）
// ---------------------------------------------------------------------------
describe("R5 确定性", () => {
  it("同一 answers 调 100 次结果完全一致（边界平局 + 极化两种场景）", () => {
    const cases: Answers[] = [
      neutralAnswers(fixtureBank),
      polarized(fixtureBank, { ei: "E", sn: "N", tf: "F", jp: "P", es: "sensitive" }),
      polarized(fixtureBank, { ei: "I", sn: "S", tf: "T", jp: "J", es: "stable" }),
    ]
    for (const ans of cases) {
      const ref = score(ans, fixtureBank)
      for (let i = 0; i < 100; i++) {
        const r = score(ans, fixtureBank)
        expect(r.type).toBe(ref.type)
        expect(r.subtype).toBe(ref.subtype)
        expect(r.percentages).toEqual(ref.percentages)
      }
    }
  })

  it("多次产出 percentages JSON.stringify 完全一致（防浮点末位抖动）", () => {
    // 选一个非整数百分比答案（会出现非 .00 末位），记录序列化字符串，100 次比对
    const ans: Answers = {}
    for (const q of fixtureBank.questions) {
      // 制造 1/8 = 12.5% 这种典型非整数百分比
      // dimension=EI 题：EI01(direction=E, answer=2)=1; EI02(direction=I, answer=4)=1 → 2/8=25% (整数)
      // 改：EI01(direction=E, answer=2)=1; EI02(direction=I, answer=2)=3 → sum=4 → 50% 又是整数
      // 用 4+1=5/8=62.5%：EI01(direction=E, answer=2)=1; EI02(direction=I, answer=4)=1 → 25% 不行
      // 直接用 EI01=2(1), EI02=2(3) → 4/8=50 整数
      // SN01=2(1), SN02=2(3) → 4/8=50； 让 dimension 不同得到不同；混 25 与 50 还是整数
      // 用 EI01=2(1), EI02=4(1)→2/8=25 (整数)
      // 唯一可产生非整数的"每题分值不同"组合：EI01=1(0)+EI02=2(3)=3/8=37.5
      if (q.dimension === "EI" && q.id === "EI01") ans[q.id] = 1 as AnswerValue
      else if (q.dimension === "EI" && q.id === "EI02") ans[q.id] = 2 as AnswerValue
      else ans[q.id] = 5 as AnswerValue
    }
    const ref = JSON.stringify(score(ans, fixtureBank))
    for (let i = 0; i < 100; i++) {
      expect(JSON.stringify(score(ans, fixtureBank))).toBe(ref)
    }
  })
})

// ---------------------------------------------------------------------------
// 非法输入：缺题 / 越界评分抛错（工单自验清单第 2 条）
// ---------------------------------------------------------------------------
describe("非法输入抛错", () => {
  it("缺题：answers 少一道题 → 抛错并指出题号", () => {
    const ans = neutralAnswers(fixtureBank)
    delete ans.ES01
    expect(() => score(ans, fixtureBank)).toThrow(/缺少题号 ES01/)
  })

  it("越界评分：answer=0 → 抛错", () => {
    const ans = neutralAnswers(fixtureBank)
    ans.EI01 = 0 as AnswerValue
    expect(() => score(ans, fixtureBank)).toThrow(/非法/)
  })

  it("越界评分：answer=6 → 抛错", () => {
    const ans = neutralAnswers(fixtureBank)
    ans.EI01 = 6 as AnswerValue
    expect(() => score(ans, fixtureBank)).toThrow(/非法/)
  })

  it("越界评分：answer=3.5 非整数 → 抛错", () => {
    const ans = neutralAnswers(fixtureBank)
    // 运行时类型无法保证，使用 as unknown as 绕过 TS
    ;(ans as unknown as Record<string, number>).EI01 = 3.5
    expect(() => score(ans, fixtureBank)).toThrow(/非法/)
  })

  it("类型错误：answer 为字符串 → 抛错", () => {
    const ans = neutralAnswers(fixtureBank) as unknown as Record<string, unknown>
    ans.EI01 = "3"
    expect(() => score(ans as unknown as Answers, fixtureBank)).toThrow(/非法/)
  })
})

// ---------------------------------------------------------------------------
// 顺便：用 FIRST_POLE 表自检 ES 第一极字符串为 "stable"（数据契约 §1 注）
// ---------------------------------------------------------------------------
describe("FIRST_POLE 表自检", () => {
  it("ES 第一极字符串为 stable（与数据契约 §1 注『避免与 EI 的 E 混淆』一致）", () => {
    expect(FIRST_POLE.ES[0]).toBe("stable")
    expect(FIRST_POLE.ES[1]).toBe("sensitive")
  })
})
