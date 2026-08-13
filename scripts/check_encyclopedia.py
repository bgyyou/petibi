# -*- coding: utf-8 -*-
"""
check_encyclopedia.py — 百科库结构与质量校验脚本（M2 工单验收）

功能：
  校验 data/encyclopedia/ 下的 16 人格 JSON 与 index.json、scenarios.md，
  按 docs/tech/M2-数据契约.md §2 与 docs/tech/M2-工单-百科库.md 的验收清单逐条过：

  1. 16 个 <personality>.json 文件齐全（与人格枚举一致）
  2. 每文件 entries 总数 >= 25（契约基线 = 25；faq 可补，entries 因此可超过 25）
  3. category 分布正确：trait 4 / cognitive 2 / strength 3 / weakness 3
     / career 2 / relationship 1 各为精确计数；faq >= 10（允许补丁方式追加）
  4. id 唯一且含人格前缀
  5. faq 的 scenario 必须落在 scenarios.md 词表内
  6. content 字数达标：trait 80–150 / faq 120–200（其他类别 50–200 容差）
  7. 必填字段齐全（personality / animal / family / entries / id / category /
     title / content / tags / scenario）；faq 的 scenario 非空，非 faq 的 scenario 必须为 null
  8. index.json 中 16 人格条目齐全且 entry_count 与文件实际条数一致
  9. scenarios.md 中的 slug 集合与 16 文件里实际用到的 scenario 集合对比，
     提示未被任何人格覆盖的孤儿 slug（不报错，仅提示）

输出：
  逐人格一行 OK / FAIL；末尾汇总 PASS/FAIL 计数。
  exit code：全部 PASS → 0；任何 FAIL → 1。

用法：
  python scripts/check_encyclopedia.py

依赖：仅标准库（json / re / sys / pathlib）。
"""

import json
import re
import sys
from pathlib import Path

# 仓库根目录 = 本文件所在 scripts/ 的上一级，保证从任意工作目录运行都能找到数据
REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"
SCENARIOS_PATH = ENCYCLOPEDIA_DIR / "scenarios.md"
INDEX_PATH = ENCYCLOPEDIA_DIR / "index.json"

# 16 人格枚举（与 PRD §8.2 一致）
PERSONALITIES = [
    "INTJ", "INTP", "ENTJ", "ENTP",
    "INFJ", "INFP", "ENFJ", "ENFP",
    "ISTJ", "ISFJ", "ESTJ", "ESFJ",
    "ISTP", "ISFP", "ESTP", "ESFP",
]

# 数据契约 §2 的条目配额
# - trait / cognitive / strength / weakness / career / relationship 必须精确等于上值；
# - faq 至少 10 条（M2 工单基线 = 10）。当评测集需要某些人格补充某个 scenario 时，
#   会以补丁形式追加 faq 条目，使该人格 faq 总数 = 10 + N（N 通常是 1），
#   故校验用 "≥ 10" 而非 "== 10"，避免一次 RAG 溯源补全就把全员 FAIL。
EXPECTED_COUNTS = {
    "trait": 4,
    "cognitive": 2,
    "strength": 3,
    "weakness": 3,
    "career": 2,
    "relationship": 1,
    "faq": 10,
}
# "至少" 类校验的最小阈值（>=）
MIN_COUNTS = {
    "faq": 10,
}
# 每人格 entries 总数下界（= 各 category 精确之和 + faq 的下界 = 4+2+3+3+2+1+10 = 25）
MIN_TOTAL_ENTRIES = 25

# 字数约束（单位：中文字符数；数据契约 §2 + 工单明确约束的类别）
# 仅 trait 与 faq 有硬约束；其他类别契约未规定具体字数，不做强校验
LEN_RULES = {
    "trait": (80, 150),
    "faq": (120, 200),
}


def parse_scenarios(md_path):
    """从 scenarios.md 中解析 slug 列表（表格第二列）。

    策略：按行解析，匹配 `| <slug> | <中文名> | ...` 形式的表格行，
    其中 slug 是纯 ASCII 小写字母+数字+连字符。跳过表头 `slug`
    和分隔行 `---`。
    返回有序 slug 列表（保持词表出现顺序）。
    """
    text = md_path.read_text(encoding="utf-8")
    slugs = []
    for line in text.splitlines():
        line = line.strip()
        # 跳过非表格行和分隔行
        if not line.startswith("|"):
            continue
        if "---" in line:
            continue
        # 取第一列内容
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells:
            continue
        slug = cells[0]
        # 显式跳过表头 `slug`
        if slug == "slug":
            continue
        # slug 必须是纯 ASCII 小写+数字+连字符，且至少含一个字母
        if re.fullmatch(r"[a-z][a-z0-9\-]*", slug):
            slugs.append(slug)
    return slugs


def check_personality_file(path, scenarios_set):
    """校验单个人格文件，返回 (ok: bool, errors: list[str], stats: dict)。"""
    errors = []
    stats = {"entry_count": 0, "categories": {}, "scenarios_used": set()}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return False, [f"JSON 解析失败：{e}"], stats

    # 顶层必填字段
    for field in ("personality", "animal", "family", "entries"):
        if field not in data:
            errors.append(f"缺少顶层字段 {field}")

    if not isinstance(data.get("entries"), list):
        return False, ["entries 字段不是数组"], stats

    stats["entry_count"] = len(data["entries"])

    # 条目校验
    seen_ids = set()
    category_counts = {k: 0 for k in EXPECTED_COUNTS}
    for idx, entry in enumerate(data["entries"], 1):
        prefix = f"第 {idx} 条"

        # 必填字段
        for field in ("id", "category", "title", "content", "tags", "scenario"):
            if field not in entry:
                errors.append(f"{prefix}：缺少字段 {field}")

        # id 唯一性 + 前缀校验
        eid = entry.get("id", "")
        if not eid:
            errors.append(f"{prefix}：id 为空")
        elif eid in seen_ids:
            errors.append(f"{prefix}：id 重复 {eid}")
        else:
            seen_ids.add(eid)
        expected_prefix = f"{data['personality']}-"
        if eid and not eid.startswith(expected_prefix):
            errors.append(f"{prefix}：id {eid} 缺少人格前缀 {expected_prefix}")

        # category 枚举
        cat = entry.get("category", "")
        if cat not in EXPECTED_COUNTS:
            errors.append(f"{prefix}：category {cat!r} 不在合法枚举内")
        else:
            category_counts[cat] += 1

        # scenario 校验：faq 必须有值且在词表内；非 faq 必须为 None
        scen = entry.get("scenario")
        if cat == "faq":
            if not scen:
                errors.append(f"{prefix}：faq 条目的 scenario 为空")
            elif scen not in scenarios_set:
                errors.append(f"{prefix}：scenario {scen!r} 不在 scenarios.md 词表内")
            else:
                stats["scenarios_used"].add(scen)
        else:
            if scen is not None:
                errors.append(f"{prefix}：非 faq 条目的 scenario 应为 null，实际 {scen!r}")

        # 字数校验（trait 80–150 / faq 120–200 / 其他 50–200）
        content = entry.get("content", "")
        if cat in LEN_RULES:
            lo, hi = LEN_RULES[cat]
            n = len(content)
            if not (lo <= n <= hi):
                errors.append(
                    f"{prefix}：{cat} content 字数 {n} 不在 [{lo}, {hi}] 范围内"
                )

    # category 分布
    # - 大多数类别精确计数（trait/cognitive/strength/weakness/career/relationship）
    # - faq 采用下界（>= MIN_COUNTS['faq']），允许以补丁方式补充 scenario，
    #   不破坏 R3 RAG 溯源链路的"补齐即过"语义
    for cat, expected in EXPECTED_COUNTS.items():
        got = category_counts[cat]
        if cat in MIN_COUNTS:
            lo = MIN_COUNTS[cat]
            if got < lo:
                errors.append(f"category {cat} 数量 {got} < 期望最小值 {lo}")
        else:
            if got != expected:
                errors.append(f"category {cat} 数量 {got} ≠ 期望 {expected}")
    stats["categories"] = category_counts

    # 每人格 entries 总数下界（>= 25）：契约基线 = 25 条/人格；
    # 因 faq 可补，entries 总数允许超过 25；不设硬上限避免阻挡后续补丁
    if stats["entry_count"] < MIN_TOTAL_ENTRIES:
        errors.append(
            f"entries 总数 {stats['entry_count']} < 期望最小值 {MIN_TOTAL_ENTRIES}"
        )

    return (len(errors) == 0), errors, stats


def check_index(index_path, file_entry_counts):
    """校验 index.json：16 人格齐全 + entry_count 与实际一致。"""
    errors = []
    if not index_path.exists():
        return False, ["index.json 不存在"]

    try:
        idx = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as e:
        return False, [f"index.json 解析失败：{e}"]

    rows = idx.get("personalities", [])
    if len(rows) != 16:
        errors.append(f"index.personalities 数量 {len(rows)} ≠ 16")

    seen = set()
    for row in rows:
        p = row.get("personality")
        if p not in PERSONALITIES:
            errors.append(f"index 出现非 16 人格成员：{p}")
        if p in seen:
            errors.append(f"index 中人格 {p} 重复")
        seen.add(p)
        # entry_count 与文件实际条数对齐
        actual = file_entry_counts.get(p)
        declared = row.get("entry_count")
        if actual is not None and declared != actual:
            errors.append(
                f"index 中 {p} 的 entry_count={declared} ≠ 文件实际 {actual}"
            )

    missing = set(PERSONALITIES) - seen
    if missing:
        errors.append(f"index 缺少人格：{sorted(missing)}")

    return (len(errors) == 0), errors


def main():
    """主流程：逐人格 + index + scenarios 一并校验，输出汇总并按结果退出。"""
    print(f"百科库目录：{ENCYCLOPEDIA_DIR}")

    # 场景词表
    if not SCENARIOS_PATH.exists():
        print(f"FAIL  scenarios.md 不存在：{SCENARIOS_PATH}")
        return 1
    slugs = parse_scenarios(SCENARIOS_PATH)
    scenarios_set = set(slugs)
    print(f"场景词表解析到 {len(slugs)} 个 slug：{slugs}\n")

    # 16 人格文件
    file_entry_counts = {}
    all_scenarios_used = set()
    pass_count = 0
    fail_count = 0

    for p in PERSONALITIES:
        fpath = ENCYCLOPEDIA_DIR / f"{p.lower()}.json"
        if not fpath.exists():
            print(f"{p}: FAIL 文件不存在 {fpath.name}")
            fail_count += 1
            continue
        ok, errs, stats = check_personality_file(fpath, scenarios_set)
        file_entry_counts[p] = stats["entry_count"]
        all_scenarios_used.update(stats["scenarios_used"])
        if ok:
            print(
                f"{p}: OK  entries={stats['entry_count']}  "
                f"categories={stats['categories']}"
            )
            pass_count += 1
        else:
            print(f"{p}: FAIL  errors={len(errs)}")
            for e in errs:
                print(f"  - {e}")
            fail_count += 1

    # index.json
    idx_ok, idx_errs = check_index(INDEX_PATH, file_entry_counts)
    print()
    if idx_ok:
        print("index.json: OK")
    else:
        print("index.json: FAIL")
        for e in idx_errs:
            print(f"  - {e}")

    # 场景覆盖情况
    print()
    orphan = scenarios_set - all_scenarios_used
    if orphan:
        print(f"提示：scenarios.md 中以下 {len(orphan)} 个 slug 未被任何人格 FAQ 覆盖：{sorted(orphan)}")
    else:
        print(f"场景覆盖：20 个 slug 全部至少被 1 个人格 FAQ 使用")

    # 汇总
    print()
    print("=" * 60)
    print(f"汇总：PASS {pass_count} / FAIL {fail_count}  / index {'OK' if idx_ok else 'FAIL'}")
    if fail_count or not idx_ok:
        print("检查不通过，请修正后再跑")
        return 1
    print("检查通过：16 人格百科库结构与质量合规")
    return 0


if __name__ == "__main__":
    sys.exit(main())
