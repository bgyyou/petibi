// 【文件说明】生成 3 张海报样张（M4 工单自验第 4 条）：
//   用 @napi-rs/canvas 在 Node 端模拟浏览器 Canvas，调用 src/share/poster.ts 的 drawPoster
//   渲染 3 张不同人格的真实 PNG，存到 assets/art/poster-samples/ 供 owner 目检。
//
// 选人格：INFP（diplomat 绿，最常见的"高敏感"代表）+ INTJ（analyst 紫，owner 默认演示人格）
//       + ESTP（explorer 黄，验证第三族色）。覆盖 3 个色系，验证族色映射正确。
//
// 设计：每张 10 次重复取 P95 耗时，输出到 stdout（自验报告粘贴用）。
// 依赖：@napi-rs/canvas（自验工具，通过 npm install --no-save 安装，未写入 package.json）。
// 字体：注册 Windows 系统 Noto Sans SC + SimHei，确保中文正常渲染。

import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

// ESM 模式下 __dirname 等价物
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// 注册中文字体（@napi-rs/canvas 在 Windows 上默认不含 CJK 字体）
GlobalFonts.registerFromPath('C:/Windows/Fonts/NotoSansSC-Regular.ttf', 'Noto Sans SC')
GlobalFonts.registerFromPath('C:/Windows/Fonts/NotoSansSC-Bold.otf', 'Noto Sans SC Bold')
// SimHei 兜底（Noto 缺失字形时）
try {
  GlobalFonts.registerFromPath('C:/Windows/Fonts/simhei.ttf', 'SimHei')
} catch {
  /* 缺字体时静默：Noto 已覆盖常用字 */
}

// 在 node 端跑 drawPoster：用 tsx loader 直接导入 .ts
const { drawPoster, POSTER_WIDTH, POSTER_HEIGHT } = await import(
  '../src/share/poster.ts'
)

// 3 张样张的人格 + 问题/回答
const SAMPLES = [
  {
    type: 'INFP',
    animal: '蝴蝶',
    nickname: '晚晚',
    question: '明天要当众演讲好紧张，怎么办？',
    answer:
      '复述确认：演讲让你很焦虑，因为你在意被看见的那一刻。\n\n作为 INFP，我通常会先把讲稿拆成 3 块核心观点，每块配一个我自己的小故事。\n\n建议：今晚先用 5 分钟跟镜子里那个"另一个你"试讲一遍，重点不是流畅而是说出"我真实想说的"。',
  },
  {
    type: 'INTJ',
    animal: '猫头鹰',
    nickname: '思考者小韩',
    question: '同事老是要我把方案改来改去，要不要怼回去？',
    answer:
      '复述确认：你担心被无意义地消耗精力，又怕直接拒绝伤关系。\n\n作为 INTJ，我通常会先判断：他们要的是"更对"还是"更舒服"。如果是前者值得改；后者我倾向于直说。\n\n建议：先问一句"你期望这次改动解决什么具体问题？"——把模糊反馈变成可执行标准。',
  },
  {
    type: 'ESTP',
    animal: '猴子',
    nickname: '小柚',
    question: '朋友放了我鸽子，要不要装作没事？',
    answer:
      '复述确认：你表面无所谓，但心里其实有点委屈。\n\n作为 ESTP，我通常不会装，但也不会当场翻脸——我会直接说"下次提前说一声就行"。\n\n建议：把这句话当成一个边界测试，不是吵架，是让对方知道你重视时间。',
  },
]

// 输出目录
const OUT_DIR = join(REPO_ROOT, 'assets', 'art', 'poster-samples')
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

/** 把 ctx 类型断言成 drawPoster 期望的 PosterCanvasContext（结构兼容） */
function asPosterCtx(ctx) {
  return ctx
}

/** 把 512×512 portrait PNG 加载成 Image 注入给 drawPoster */
async function loadPortrait(type) {
  const p = join(REPO_ROOT, 'assets', 'art', 'portraits', `${type.toLowerCase()}.png`)
  const { loadImage } = await import('@napi-rs/canvas')
  return loadImage(p)
}

/** 生成单张：含重复 10 次耗时统计（P95） */
async function generateOne(sample) {
  const portrait = await loadPortrait(sample.type)
  // 1 次试运行（warmup，JIT 优化 + 字体光栅化缓存）
  {
    const c = createCanvas(POSTER_WIDTH, POSTER_HEIGHT)
    drawPoster(asPosterCtx(c.getContext('2d')), {
      personaType: sample.type,
      animal: sample.animal,
      nickname: sample.nickname,
      question: sample.question,
      answer: sample.answer,
      portraitImage: portrait,
    })
    await c.encode('png')
  }

  // 10 次实测：drawPoster + PNG 编码（端到端真实耗时）
  const samples = []
  for (let i = 0; i < 10; i++) {
    const c = createCanvas(POSTER_WIDTH, POSTER_HEIGHT)
    const t0 = performance.now()
    drawPoster(asPosterCtx(c.getContext('2d')), {
      personaType: sample.type,
      animal: sample.animal,
      nickname: sample.nickname,
      question: sample.question,
      answer: sample.answer,
      portraitImage: portrait,
    })
    const png = await c.encode('png')
    samples.push(performance.now() - t0)
    if (i === 0) {
      // 只在第 1 次保存 PNG
      const outPath = join(OUT_DIR, `${sample.type.toLowerCase()}.png`)
      writeFileSync(outPath, png)
      console.log(`[生成] ${sample.type} → ${outPath} (${(png.length / 1024).toFixed(1)}KB)`)
    }
  }
  samples.sort((a, b) => a - b)
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  const max = samples[samples.length - 1]
  return { type: sample.type, p50, p95, max, samples }
}

console.log('===== M4 海报生成耗时实测（每张 10 次取 P95）=====')
const allResults = []
for (const s of SAMPLES) {
  const r = await generateOne(s)
  allResults.push(r)
  console.log(
    `[耗时] ${r.type}  P50=${r.p50.toFixed(1)}ms  P95=${r.p95.toFixed(1)}ms  MAX=${r.max.toFixed(1)}ms`,
  )
}
const allP95 = allResults.flatMap((r) => r.samples.slice(-2)) // 取每张的 P95+P100
const overallMax = Math.max(...allP95)
console.log(`\n全局 P95 上界 = ${overallMax.toFixed(1)}ms  （REVIEW §2.5 阈值 3000ms）`)
if (overallMax <= 3000) {
  console.log('✅ 通过：所有样张生成 ≤ 3 秒')
} else {
  console.log('❌ 失败：超 3 秒')
  process.exit(1)
}
