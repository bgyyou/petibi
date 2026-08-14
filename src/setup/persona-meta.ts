// 【文件说明】16 人格 → 动物 / 细分标签中文映射常量。
// 数据来源：PRD §8.2（人格→动物映射表）+ PRD §3.3 / 数据契约 §4（细分坚定型/善感型）。
//
// 这一份只是 UI 展示用的元数据，不参与计分；计分引擎只看 type/subtype 的英文标识。

export type MbtiType =
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'

// 4 族：analyst（分析家）、diplomat（外交家）、sentinel（守护者）、explorer（探险家）
export type Family = 'analyst' | 'diplomat' | 'sentinel' | 'explorer'

export interface PersonaMeta {
  type: MbtiType
  animal: string
  family: Family
  // 一句话中文短描述（用在结果页卡片上），不参与 AI 回答
  tagline: string
}

// 16 人格卡片（顺序固定：先四族 × 四字母）
export const PERSONAS: PersonaMeta[] = [
  // 分析家 analyst（紫系）
  { type: 'INTJ', animal: '猫头鹰', family: 'analyst',   tagline: '独立、长远规划的建筑师' },
  { type: 'INTP', animal: '猫',     family: 'analyst',   tagline: '追根究底的逻辑学家' },
  { type: 'ENTJ', animal: '狮子',   family: 'analyst',   tagline: '果断的指挥官' },
  { type: 'ENTP', animal: '狐狸',   family: 'analyst',   tagline: '爱辩论的智多星' },
  // 外交家 diplomat（绿系）
  { type: 'INFJ', animal: '天鹅',   family: 'diplomat',  tagline: '安静坚定的提倡者' },
  { type: 'INFP', animal: '蝴蝶',   family: 'diplomat',  tagline: '理想主义的调停者' },
  { type: 'ENFJ', animal: '金毛',   family: 'diplomat',  tagline: '温暖的主人公' },
  { type: 'ENFP', animal: '海豚',   family: 'diplomat',  tagline: '热情的竞选者' },
  // 守护者 sentinel（蓝系）
  { type: 'ISTJ', animal: '海狸',   family: 'sentinel',  tagline: '靠谱的物流师' },
  { type: 'ISFJ', animal: '企鹅',   family: 'sentinel',  tagline: '细腻的守卫者' },
  { type: 'ESTJ', animal: '熊',     family: 'sentinel',  tagline: '实务的总经理' },
  { type: 'ESFJ', animal: '大象',   family: 'sentinel',  tagline: '热心的执政官' },
  // 探险家 explorer（黄系）
  { type: 'ISTP', animal: '豹',     family: 'explorer',  tagline: '动手派的鉴赏家' },
  { type: 'ISFP', animal: '卡皮巴拉', family: 'explorer', tagline: '温柔的探险家' },
  { type: 'ESTP', animal: '猴子',   family: 'explorer',  tagline: '灵活的企业家' },
  { type: 'ESFP', animal: '鹦鹉',   family: 'explorer',  tagline: '爱热闹的表演者' },
]

/** 类型 → 元数据查表（O(1) 查找，结果页用） */
const META_INDEX: Record<string, PersonaMeta> = PERSONAS.reduce(
  (acc, p) => ({ ...acc, [p.type]: p }),
  {} as Record<string, PersonaMeta>
)

export function getPersona(type: string): PersonaMeta | null {
  return META_INDEX[type] ?? null
}

// 细分标签中文映射
export const SUBTYPE_LABELS: Record<'stable' | 'sensitive', string> = {
  stable: '坚定型',
  sensitive: '善感型',
}

/** 把"ENFJ / stable"这种组合转成"ENFJ·坚定型"展示 */
export function formatTypeLabel(type: string, subtype: 'stable' | 'sensitive'): string {
  return `${type}·${SUBTYPE_LABELS[subtype]}`
}

// 4 族 → CSS 色系（DESIGN.md §2 / T3 工单 v1 族色统一）。
// 用法：16 选 1 卡片背景（bg）、结果页大字与按钮（fg）、卡片边框（border）。
// fg / bg 取自设计规范的四族色；border 仍用族色描边的中间明度，靠近族色但不抢眼。
export const FAMILY_COLORS: Record<Family, { bg: string; fg: string; border: string }> = {
  analyst:  { bg: '#f1ebf6', fg: '#785D87', border: '#785D87' },
  diplomat: { bg: '#e8f3ec', fg: '#3E8F6E', border: '#3E8F6E' },
  sentinel: { bg: '#e6eef7', fg: '#399FB9', border: '#399FB9' },
  explorer: { bg: '#fbf2dc', fg: '#E4C728', border: '#E4C728' },
}