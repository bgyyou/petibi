// 【文件说明】日期工具：本地时区 YYYY-MM-DD 字符串，与 A / B 两套实现对齐。
// 数据库存的 date 用本地日，便于按"用户的凌晨"切分（每天 0 点重置配额）。

/**
 * 按本地时区返回 "YYYY-MM-DD" 日期串。
 */
export function todayDateString(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = (now.getMonth() + 1).toString().padStart(2, "0")
  const d = now.getDate().toString().padStart(2, "0")
  return `${y}-${m}-${d}`
}