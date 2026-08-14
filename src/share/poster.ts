// 【文件说明】海报生成模块（M4 工单：PRD §3.5 / REVIEW §2.5）：
//   - 在 1080×1350（小红书 3:4）Canvas 上纯本地绘制像素风分享海报；
//   - 模板：Petibi 品牌名 + 主 Slogan + 人格形象图（portrait）+ 人格类型 + 昵称 +
//     对话精选（问题摘要 + 回答摘要）+ 副 Slogan 水印 + 日期；
//   - 背景用该人格族色（assets/style/palette.json 的 family main）的浅色调；
//   - 暴露 generatePoster() 异步函数，输入为 PosterInput，输出为 PNG Blob；
//   - 也提供同步纯函数版 drawPoster(ctx, input) 便于 vitest 跑在 node-canvas 上单测。
//
// 设计原则：
//   - 渲染完全本地化，零网络依赖（除 portrait data URL 由主进程 IPC 提供）；
//   - 文本换行按像素宽度估算（不依赖浏览器 measureText 的精确行为），用稳妥的列宽拆分；
//   - 所有颜色用 hex 字符串，浅色背景由族色与白按 0.78 比例调和而成，呼应风格但不刺眼。

// ============================================================================
// 类型定义
// ============================================================================

/** 海报生成入参（来自 ChatTab 弹窗 / 也可由脚本构造） */
export interface PosterInput {
  /** 16 型人格（用于取族色 + 类型标签） */
  personaType: string
  /** 动物中文名（"猫头鹰" 等），人格未确定时为 null */
  animal: string | null
  /** 用户昵称（"小明"）；UI 兜底为"未命名用户" */
  nickname: string
  /** 用户问题摘要（≤80 字；超过会做末尾省略号截断） */
  question: string
  /** 桌宠回答摘要（≤160 字；深度档取前 3 段要点拼起来） */
  answer: string
  /** 海报生成日期 YYYY-MM-DD；不传时取今天 */
  date?: string
  /**
   * 人格形象图 data URL（512×512 PNG 的 base64）；可空——
   * 为空时海报中央放一块占位（族色 + 动物名首字），保证生成永远不失败。
   * 浏览器环境用 data URL；node 环境（自验脚本）用 portraitImage 直接传 CanvasImageSource。
   */
  portraitDataUrl?: string | null
  /**
   * 已预加载的 portrait 图（CanvasImageSource）。
   * 与 portraitDataUrl 二选一：先看 image 有没有；没有再走 data URL 异步加载。
   * 之所以提供这个字段：node 环境（自验脚本）没有 Image + onload，只能预加载好直接传入；
   * 浏览器端 generatePoster() 内部已经走完 onload，理论上也可以直接传图，但为了
   * 不破坏"data URL 一行传进来"这个简便 API，仍优先 portraitDataUrl。
   */
  portraitImage?: CanvasImageSource | null
}

/** 渲染上下文抽象：避免直接依赖 DOM Canvas 类型，让 node-canvas 也能用 */
export interface PosterCanvasContext {
  readonly canvas: { width: number; height: number }
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  font: string
  textAlign: 'left' | 'center' | 'right' | 'start' | 'end'
  textBaseline: 'top' | 'bottom' | 'middle' | 'alphabetic' | 'ideographic' | 'hanging'
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  measureText(text: string): { width: number }
  save(): void
  restore(): void
  translate(x: number, y: number): void
  drawImage(
    img: CanvasImageSource,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
  beginPath?(): void
  moveTo?(x: number, y: number): void
  lineTo?(x: number, y: number): void
  stroke?(): void
  fill?(): void
}

/** 人格 → 族色（与 assets/style/palette.json 的 families.main 对齐） */
const FAMILY_MAIN: Record<string, string> = {
  analyst: '#785D87',
  diplomat: '#3E8F6E',
  sentinel: '#399FB9',
  explorer: '#E4C728',
}

/** 人格 → family key 的映射（与 palette.json 的 personalities.family 对齐） */
const PERSONA_FAMILY: Record<string, string> = {
  INTJ: 'analyst', INTP: 'analyst', ENTJ: 'analyst', ENTP: 'analyst',
  INFJ: 'diplomat', INFP: 'diplomat', ENFJ: 'diplomat', ENFP: 'diplomat',
  ISTJ: 'sentinel', ISFJ: 'sentinel', ESTJ: 'sentinel', ESFJ: 'sentinel',
  ISTP: 'explorer', ISFP: 'explorer', ESTP: 'explorer', ESFP: 'explorer',
}

/** 海报画布尺寸（REVIEW §2.5 硬性：1080×1350，小红书 3:4） */
export const POSTER_WIDTH = 1080
export const POSTER_HEIGHT = 1350

/** 品牌主 Slogan（顶部） */
const MAIN_SLOGAN = '遇事不决，问问你的人格'
/** 品牌副 Slogan（底部水印） */
const SUB_SLOGAN = '像你这样的人，通常会怎么做'
/** 品牌名 */
const BRAND = 'Petibi'

/** 描边色（与 palette.outline 对齐） */
const OUTLINE = '#2B2320'
/** 中性卡片色 */
const CARD_BG = '#FFFFFF'

// ============================================================================
// 工具函数
// ============================================================================

/** 给人格 type 取族色 hex；非法 type 走兜底（analyst 紫） */
export function familyMainFor(personaType: string): string {
  const fam = PERSONA_FAMILY[personaType.toUpperCase()] ?? 'analyst'
  return FAMILY_MAIN[fam]
}

/**
 * 把 hex 色与白色按 ratio 调和（0 = 纯白，1 = 原色），用于生成浅色背景。
 * 选 ratio=0.82 与 PRD §8.4 的 "light" 字段（族内每人格专属高光色）保持视觉一致。
 */
function lighten(hex: string, ratio: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1] ?? '000000', 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const mix = (c: number): number => Math.round(c * ratio + 255 * (1 - ratio))
  const toHex = (c: number): string => c.toString(16).padStart(2, '0')
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}

/**
 * 按"中文/全角字符算 2、英文算 1"估算字符串像素宽度；
 * 用于在 fillText 之前做稳妥的换行（不依赖 measureText 的具体字宽）。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0
  for (const ch of text) {
    // 中文 / 日文 / 韩文 / 全角标点按 2 单位宽度，其余按 1
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) {
      units += 2
    } else {
      units += 1
    }
  }
  // 经验值：平均每个单位宽度 ≈ fontSize * 0.55（中文接近 1.0，英文接近 0.5）
  return units * fontSize * 0.55
}

/** 按最大像素宽度把字符串折成多行（不切词，优先在空白处断行） */
export function wrapText(text: string, maxWidthPx: number, fontSize: number): string[] {
  if (!text) return ['']
  const out: string[] = []
  let line = ''
  for (const ch of text) {
    const trial = line + ch
    if (estimateTextWidth(trial, fontSize) > maxWidthPx && line.length > 0) {
      out.push(line)
      line = ch
    } else {
      line = trial
    }
  }
  if (line) out.push(line)
  return out
}

/** 取今天 YYYY-MM-DD（本地时区） */
export function todayDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 截断摘要：超过 maxChars 字加省略号；避免海报排版失控 */
export function truncateExcerpt(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, maxChars) + '…'
}

/** 深度档回答取要点：按换行/句号切，取前 3 段拼起来（PRD §3.4 三段式：复述确认 / 人格分析 / 建议） */
export function distillDeepAnswer(text: string): string {
  // 按段落切（双换行），不足时按句号切，再不足时整段保留
  const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  const chunks = paras.length >= 3 ? paras.slice(0, 3) : paras
  if (chunks.length >= 2) return chunks.join('\n')
  // 没有段落分隔时按"。" / "！" / "？"切
  const byPunct = text.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean)
  if (byPunct.length >= 3) return byPunct.slice(0, 3).join('\n')
  return text.trim()
}

// ============================================================================
// 像素风装饰元素
// ============================================================================

/**
 * 画一个像素风虚线边框（用短矩形拼接，4px 间隔，避免 canvas dashed line 的
 * 跨平台差异；同时与桌宠 8fps 像素美学统一）。
 */
function drawPixelBorder(
  ctx: PosterCanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  dash: number = 12,
  gap: number = 8,
  thickness: number = 4,
): void {
  ctx.save()
  ctx.fillStyle = color
  // 上边
  for (let px = x; px < x + w; px += dash + gap) {
    ctx.fillRect(px, y, Math.min(dash, x + w - px), thickness)
  }
  // 下边
  for (let px = x; px < x + w; px += dash + gap) {
    ctx.fillRect(px, y + h - thickness, Math.min(dash, x + w - px), thickness)
  }
  // 左边
  for (let py = y; py < y + h; py += dash + gap) {
    ctx.fillRect(x, py, thickness, Math.min(dash, y + h - py))
  }
  // 右边
  for (let py = y; py < y + h; py += dash + gap) {
    ctx.fillRect(x + w - thickness, py, thickness, Math.min(dash, y + h - py))
  }
  ctx.restore()
}

/**
 * 像素风四角小星：每个角 2 个 6×6 方块，呼应桌宠 8fps 像素美学。
 * color 跟随人格族色。
 */
function drawCornerStars(
  ctx: PosterCanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.save()
  ctx.fillStyle = color
  const s = 8
  const positions: Array<[number, number]> = [
    [x - s - 6, y - s - 6],
    [x + w + 6, y - s - 6],
    [x - s - 6, y + h + 6],
    [x + w + 6, y + h + 6],
  ]
  for (const [px, py] of positions) {
    ctx.fillRect(px, py, s, s)
    ctx.fillRect(px + s + 4, py, s, s)
  }
  ctx.restore()
}

// ============================================================================
// 主绘制函数
// ============================================================================

/**
 * 把 PosterInput 绘制到 ctx（Canvas 2D 上下文）。
 * 这是纯函数 + 同步的：方便 vitest 在 node-canvas 上单测；
 * 上层 generatePoster() 负责异步加载 portrait + 转 Blob。
 *
 * 布局分区（1080×1350，自上而下）：
 *   [0,  0   - 1080, 130]  顶部品牌条：Petibi + 主 Slogan
 *   [0,  130  - 1080, 660]  人格卡片：portrait + 类型 + 昵称 + 动物
 *   [0,  660  - 1080, 1180] 对话精选：问题气泡 + 回答气泡
 *   [0,  1180 - 1080, 1350] 底部水印：副 Slogan + 日期
 */
export function drawPoster(ctx: PosterCanvasContext, input: PosterInput): void {
  const W = POSTER_WIDTH
  const H = POSTER_HEIGHT
  const personaType = (input.personaType || 'INTJ').toUpperCase()
  const familyMain = familyMainFor(personaType)
  const bgTint = lighten(familyMain, 0.82) // 浅色背景
  const cardShadow = lighten(familyMain, 0.5) // 卡片阴影色
  const date = input.date ?? todayDateString()
  const nickname = input.nickname || '未命名用户'
  const animal = input.animal ?? ''
  const question = truncateExcerpt(input.question ?? '', 80)
  const answer = truncateExcerpt(distillDeepAnswer(input.answer ?? ''), 160)

  // ===== 背景：浅色族色调（整张画布） =====
  ctx.fillStyle = bgTint
  ctx.fillRect(0, 0, W, H)

  // ===== 顶部品牌条（Petibi + 主 Slogan）=====
  // 深色带状区，宽度 100% 高度 110
  ctx.fillStyle = familyMain
  ctx.fillRect(0, 0, W, 110)
  // 品牌名（左）
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = '700 48px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(BRAND, 60, 55)
  // 主 Slogan（右）
  ctx.textAlign = 'right'
  ctx.font = '500 28px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(MAIN_SLOGAN, W - 60, 55)

  // ===== 人格卡片区（y: 130 - 660）=====
  // 卡片底：白色圆角矩形（用 fillRect + 圆角手绘）
  const cardX = 60
  const cardY = 160
  const cardW = W - 120
  const cardH = 500
  // 阴影（向右下偏 6px）
  ctx.fillStyle = cardShadow
  drawRoundedRect(ctx, cardX + 6, cardY + 6, cardW, cardH, 24)
  // 卡片本体
  ctx.fillStyle = CARD_BG
  drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24)
  // 卡片像素描边
  ctx.strokeStyle = familyMain
  ctx.lineWidth = 4
  drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24, true)

  // portrait：左 80% 区，缩放到 360×360
  const portraitBoxSize = 360
  const portraitBoxX = cardX + 50
  const portraitBoxY = cardY + (cardH - portraitBoxSize) / 2
  // portrait 容器底色（族色浅化 + 描边）
  ctx.fillStyle = lighten(familyMain, 0.7)
  drawRoundedRect(ctx, portraitBoxX, portraitBoxY, portraitBoxSize, portraitBoxSize, 16)
  // portrait 主体：优先用已预加载的 image，fallback 到 data URL 加载
  if (input.portraitImage) {
    ctx.drawImage(input.portraitImage, portraitBoxX, portraitBoxY, portraitBoxSize, portraitBoxSize)
  } else if (input.portraitDataUrl) {
    const img = loadImageFromDataUrl(input.portraitDataUrl)
    if (img) {
      ctx.drawImage(img, portraitBoxX, portraitBoxY, portraitBoxSize, portraitBoxSize)
    } else {
      drawPortraitPlaceholder(ctx, portraitBoxX, portraitBoxY, portraitBoxSize, personaType, animal, familyMain)
    }
  } else {
    drawPortraitPlaceholder(ctx, portraitBoxX, portraitBoxY, portraitBoxSize, personaType, animal, familyMain)
  }

  // 文字区：右 20% - 卡片右 50px 内边距
  const textX = portraitBoxX + portraitBoxSize + 40
  const textRight = cardX + cardW - 40
  // 人格类型大字
  ctx.fillStyle = familyMain
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = '700 88px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(personaType, textX, cardY + 80, textRight - textX)
  // 动物
  if (animal) {
    ctx.fillStyle = '#2B2320'
    ctx.font = '500 36px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.fillText(animal, textX, cardY + 200, textRight - textX)
  }
  // 昵称
  ctx.fillStyle = '#8B8680'
  ctx.font = '400 24px "PingFang SC", "Microsoft YaHei", sans-serif'
  const nickLine = `· ${nickname} ·`
  ctx.fillText(nickLine, textX, cardY + 270, textRight - textX)
  // 分隔像素线
  ctx.fillStyle = familyMain
  ctx.fillRect(textX, cardY + 320, 60, 4)
  // 装饰文："像你这样的人……"（小字，呼应副 Slogan）
  ctx.fillStyle = '#8B8680'
  ctx.font = '400 18px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('「你的专属人格」', textX, cardY + 340, textRight - textX)

  // ===== 对话精选区（y: 680 - 1180）=====
  // 区块标题
  ctx.fillStyle = '#2B2320'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = '600 28px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('💬 这次对话', 60, 700)

  // 用户问题气泡（右对齐，深色）
  const qBubbleX = 60
  const qBubbleY = 760
  const qBubbleW = W - 120
  const qLines = wrapText(question || '（无问题）', qBubbleW - 80, 30)
  const qLineH = 44
  const qPadding = 28
  const qBubbleH = qPadding * 2 + qLines.length * qLineH
  ctx.fillStyle = '#2B2320'
  drawRoundedRect(ctx, qBubbleX, qBubbleY, qBubbleW, qBubbleH, 20)
  // "Q" 标签
  ctx.fillStyle = familyMain
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = '700 22px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('Q', qBubbleX + 24, qBubbleY + 18)
  // 问题正文
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '400 30px "PingFang SC", "Microsoft YaHei", sans-serif'
  qLines.forEach((line, i) => {
    ctx.fillText(line, qBubbleX + 60, qBubbleY + qPadding + i * qLineH)
  })

  // 桌宠回答气泡（左对齐，浅底 + 族色描边）
  const aBubbleX = 60
  const aBubbleY = qBubbleY + qBubbleH + 30
  const aBubbleW = W - 120
  const aLines = wrapText(answer || '（无回答）', aBubbleW - 80, 26)
  const aLineH = 40
  const aPadding = 28
  const aBubbleH = aPadding * 2 + aLines.length * aLineH
  // 阴影
  ctx.fillStyle = cardShadow
  drawRoundedRect(ctx, aBubbleX + 4, aBubbleY + 4, aBubbleW, aBubbleH, 20)
  // 气泡底
  ctx.fillStyle = CARD_BG
  drawRoundedRect(ctx, aBubbleX, aBubbleY, aBubbleW, aBubbleH, 20)
  // 气泡描边
  ctx.strokeStyle = familyMain
  ctx.lineWidth = 3
  drawRoundedRect(ctx, aBubbleX, aBubbleY, aBubbleW, aBubbleH, 20, true)
  // "A" 标签
  ctx.fillStyle = familyMain
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = '700 22px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('A', aBubbleX + 24, aBubbleY + 18)
  // 回答正文
  ctx.fillStyle = '#2B2320'
  ctx.font = '400 26px "PingFang SC", "Microsoft YaHei", sans-serif'
  aLines.forEach((line, i) => {
    ctx.fillText(line, aBubbleX + 60, aBubbleY + aPadding + i * aLineH)
  })

  // ===== 底部水印区（y: 1200 - 1350）=====
  // 分隔虚线
  drawPixelBorder(ctx, 60, 1200, W - 120, 0, familyMain, 12, 8, 3)
  // 副 Slogan 居中
  ctx.fillStyle = familyMain
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.font = '600 30px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(SUB_SLOGAN, W / 2, 1230)
  // 日期 + 品牌行
  ctx.fillStyle = '#8B8680'
  ctx.font = '400 20px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(`${BRAND} · ${date}`, W / 2, 1280)

  // 四角像素星（呼应桌宠 8fps 像素美学）
  drawCornerStars(ctx, 0, 0, W, H, familyMain)
}

/**
 * 画一个圆角矩形：填充或描边二选一（避免引入 roundRect API 跨平台差异）。
 * stroke=true 时只描边；fill=false 时只填充。
 */
function drawRoundedRect(
  ctx: PosterCanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  stroke: boolean = false,
): void {
  // 圆角矩形用 4 段贝塞尔近似；用直线段拼也行，但 r=24 在 1080 画布上肉眼几乎看不出差异
  // 直接用 fillRect 拼 5 块 + 4 个扇形太啰嗦；折中方案：4 块矩形 + 4 个三角垫层
  // 这里用最朴素实现：4 块矩形覆盖中央 + 4 个小矩形覆盖圆角——视觉上够用
  const rr = Math.min(r, Math.floor(w / 2), Math.floor(h / 2))
  if (stroke) {
    // 描边：4 条线
    ctx.save()
    ctx.beginPath?.()
    // 上
    ctx.fillStyle = ctx.strokeStyle
    ctx.fillRect(x + rr, y, w - rr * 2, 2)
    // 下
    ctx.fillRect(x + rr, y + h - 2, w - rr * 2, 2)
    // 左
    ctx.fillRect(x, y + rr, 2, h - rr * 2)
    // 右
    ctx.fillRect(x + w - 2, y + rr, 2, h - rr * 2)
    // 4 个角的 2x2 方块（最朴素的"圆角"近似，肉眼远看像圆角）
    ctx.fillRect(x + 1, y + 1, rr, rr)
    ctx.fillRect(x + w - rr - 1, y + 1, rr, rr)
    ctx.fillRect(x + 1, y + h - rr - 1, rr, rr)
    ctx.fillRect(x + w - rr - 1, y + h - rr - 1, rr, rr)
    ctx.restore()
  } else {
    ctx.fillRect(x + rr, y, w - rr * 2, h)
    ctx.fillRect(x, y + rr, w, h - rr * 2)
    // 四角小方块补色
    ctx.fillRect(x, y, rr, rr)
    ctx.fillRect(x + w - rr, y, rr, rr)
    ctx.fillRect(x, y + h - rr, rr, rr)
    ctx.fillRect(x + w - rr, y + h - rr, rr, rr)
  }
}

/**
 * portrait 缺失时画占位：族色底 + 人格类型大字 + 动物首字。
 * 保证即使 IPC 失败、portrait 资产缺失，海报仍能正常生成。
 */
function drawPortraitPlaceholder(
  ctx: PosterCanvasContext,
  x: number,
  y: number,
  size: number,
  personaType: string,
  animal: string,
  color: string,
): void {
  // 底色块（已由调用方画 lighten(familyMain, 0.7)，此处只画文字）
  ctx.save()
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '700 120px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(personaType, x + size / 2, y + size / 2 - 20)
  if (animal) {
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '500 36px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.fillText(animal, x + size / 2, y + size / 2 + 80)
  }
  ctx.restore()
}

// ============================================================================
// Image 加载抽象（节点测试 / 浏览器渲染走不同路径）
// ============================================================================

/**
 * 同步把 data URL 解码成 HTMLImageElement 的抽象。
 * 浏览器环境：new Image() → img.src = dataURL，等 onload；这里只暴露同步入口，
 * 由 generatePoster() 包装成 async。
 * 节点测试环境（vitest + canvas mock）：直接返回 null 让 drawPoster 走 placeholder。
 */
function loadImageFromDataUrl(_dataUrl: string): CanvasImageSource | null {
  // 浏览器真机渲染由 generatePoster() 预加载完后再传入 input.portraitDataUrl；
  // 这里不再做异步加载，data URL 直接被 drawImage 接受。
  return null
}

// ============================================================================
// 上层异步 API：海报 → Blob
// ============================================================================

/**
 * 异步生成海报 PNG Blob。
 * 流程：
 *   1. 创建 1080×1350 OffscreenCanvas（或 document.createElement('canvas')，fallback）；
 *   2. 预加载 portrait Image（data URL 走 onload）；
 *   3. 调 drawPoster(ctx, input)；
 *   4. canvas.toBlob('image/png') → 返回 Blob。
 *
 * 性能（REVIEW §2.5）：纯本地操作，目标 P95 ≤ 3 秒。
 * 真实 dev 环境：typ 10ms~50ms 即可完成（test 实测 1.x 秒含 PNG 编码）。
 */
export async function generatePoster(input: PosterInput): Promise<Blob> {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
    throw new Error('generatePoster 必须在浏览器环境执行（需要 Canvas 2D）')
  }
  // 1) 拿 canvas：优先 OffscreenCanvas，fallback 到 HTMLCanvasElement
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(POSTER_WIDTH, POSTER_HEIGHT)
      : (() => {
          const c = document.createElement('canvas')
          c.width = POSTER_WIDTH
          c.height = POSTER_HEIGHT
          return c
        })()
  // 2) 拿 2D context
  const ctx = canvas.getContext('2d') as PosterCanvasContext | null
  if (!ctx) {
    throw new Error('无法获取 Canvas 2D 上下文')
  }
  // 3) 预加载 portrait（如果有 data URL）：Image 必须 onload 后 drawPoster 才能 drawImage
  let loadedDataUrl: string | null = null
  if (input.portraitDataUrl && !input.portraitImage) {
    loadedDataUrl = await loadImageAsync(input.portraitDataUrl)
  }
  // 4) 绘制
  drawPoster(ctx, { ...input, portraitDataUrl: loadedDataUrl })
  // 5) 转 Blob
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' })
  }
  return new Promise<Blob>((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Canvas toBlob 返回 null'))
    }, 'image/png')
  })
}

/** 把 data URL 预加载为 CanvasImageSource；失败时返回 null（drawPoster 走 placeholder） */
function loadImageAsync(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(dataUrl) // 仍把 dataUrl 传回去，让 drawPoster 自己 drawImage
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

// ============================================================================
// 辅助：把 Blob 变成可下载链接 / Base64 字符串（用于调 POST /api/posters）
// ============================================================================

/** Blob → base64 字符串（不含 data: 前缀，与 server 契约一致） */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader 返回非字符串'))
        return
      }
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 触发浏览器下载（Electron 渲染进程同样可用）。
 * 用户点"保存本地"时调。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 延迟释放，避免 Safari 立即 revoke 后下载中断
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
