# -*- coding: utf-8 -*-
"""
check_eval.py — 评测集 eval/persona_eval.jsonl 合规检查脚本（M2 工单 / 数据契约 §3 / 红线 R3）

功能：
  校验 eval/persona_eval.jsonl 是否符合数据契约 §3 的全部硬性约束：
    1. 总条数 = 80
    2. 16 人格 × 5 情境 均匀分布（每个 (personality, scenario) 组合恰好 1 条）
    3. 每条字段齐全：id / personality / scenario / question / key_points / source_entries / trap
    4. key_points 长度在 [2, 4]
    5. source_entries 的 id 格式合法：<TYPE>-faq-<scenario>（TYPE 全大写、scenario 与本条 scenario 一致）
    6. trap 非空
    7. id 格式合法：eval-<personality 小写>-<两位序号>
    8. JSON 每行可解析（不留尾随空白 / 多余逗号）

输出：
  逐项打印 OK / 失败原因；末尾汇总。失败即退出 1（供验收拦截用）。

用法：
  python scripts/check_eval.py                            # 默认 eval/persona_eval.jsonl
  python scripts/check_eval.py <path-to-jsonl>           # 指定文件
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# Windows 默认 stdout 是 GBK，emoji / 部分中文标点会触发 UnicodeEncodeError。
# 显式按 UTF-8 输出，避免验收时终端编码不一致导致崩溃。
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# 16 种 MBTI 主线人格（数据契约隐含全集，本脚本显式列举便于均匀性检查）
PERSONALITIES = [
    "INTJ", "INTP", "ENTJ", "ENTP",
    "INFJ", "INFP", "ENFJ", "ENFP",
    "ISTJ", "ISFJ", "ESTJ", "ESFJ",
    "ISTP", "ISFP", "ESTP", "ESFP",
]

# 5 个最高频情境（工单指定：public-speaking / conflict / deadline / criticism / teamwork）
SCENARIOS = ["public-speaking", "conflict", "deadline", "criticism", "teamwork"]

# id 格式：eval-<lowercase>-<NN>
ID_RE = re.compile(r"^eval-([a-z]+)-(\d{2})$")

# source_entries 格式：<TYPE>-faq-<scenario>
ENTRY_RE = re.compile(r"^([A-Z]{4})-faq-([a-z\-]+)$")


def fail(msg):
    """打印失败信息并累计错误计数"""
    print(f"  [FAIL] {msg}")
    return 1


def ok(msg):
    """打印通过信息"""
    print(f"  [OK]   {msg}")


def check(path):
    """执行全部校验，返回错误数（0 表示全部通过）"""
    errors = 0

    print(f"=== 评测集合规校验：{path} ===")

    # 1. 文件存在
    if not path.exists():
        print(f"  [FAIL] 文件不存在：{path}")
        return 1

    # 2. 读取并逐行解析 JSON
    rows = []
    with path.open("r", encoding="utf-8") as fp:
        for lineno, raw in enumerate(fp, start=1):
            raw = raw.strip()
            if not raw:
                continue  # 允许空行
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as exc:
                errors += fail(f"第 {lineno} 行 JSON 解析失败：{exc}")
                continue
            rows.append((lineno, obj))

    print(f"  [INFO] 共解析 {len(rows)} 条 JSON")

    # 3. 总条数 = 80
    if len(rows) == 80:
        ok(f"总条数 = {len(rows)}")
    else:
        errors += fail(f"总条数 {len(rows)} ≠ 80")

    # 4. 字段齐全 + 字段级校验
    required_fields = ["id", "personality", "scenario", "question", "key_points", "source_entries", "trap"]
    seen_pairs = Counter()
    id_set = set()
    for lineno, obj in rows:
        # 字段齐全
        missing = [f for f in required_fields if f not in obj]
        if missing:
            errors += fail(f"第 {lineno} 行缺字段：{missing}")
            continue

        personality = obj["personality"]
        scenario = obj["scenario"]

        # id 格式 + 唯一
        rid = obj["id"]
        m = ID_RE.match(rid)
        if not m:
            errors += fail(f"第 {lineno} 行 id '{rid}' 格式不符 eval-<lowercase>-NN")
        else:
            lower_type, num = m.group(1), m.group(2)
            if lower_type != personality.lower():
                errors += fail(f"第 {lineno} 行 id '{rid}' 与 personality '{personality}' 不一致")
            if num not in {"01", "02", "03", "04", "05"}:
                errors += fail(f"第 {lineno} 行 id '{rid}' 序号 {num} 不在 01-05")
        if rid in id_set:
            errors += fail(f"第 {lineno} 行 id '{rid}' 重复")
        id_set.add(rid)

        # personality 在 16 型内
        if personality not in PERSONALITIES:
            errors += fail(f"第 {lineno} 行 personality '{personality}' 不在 16 型内")

        # scenario 在 5 情境内
        if scenario not in SCENARIOS:
            errors += fail(f"第 {lineno} 行 scenario '{scenario}' 不在 5 情境内")

        # question 非空且长度合理
        question = obj["question"]
        if not isinstance(question, str) or not question.strip():
            errors += fail(f"第 {lineno} 行 question 为空")
        elif len(question) < 8:
            errors += fail(f"第 {lineno} 行 question 过短（<8 字）")

        # key_points: 2-4 条字符串
        kps = obj["key_points"]
        if not isinstance(kps, list):
            errors += fail(f"第 {lineno} 行 key_points 不是列表")
        elif not (2 <= len(kps) <= 4):
            errors += fail(f"第 {lineno} 行 key_points 条数 {len(kps)} 不在 [2,4]")
        else:
            for i, kp in enumerate(kps):
                if not isinstance(kp, str) or not kp.strip():
                    errors += fail(f"第 {lineno} 行 key_points[{i}] 为空")

        # source_entries: 至少 1 条，格式 <TYPE>-faq-<scenario>
        ses = obj["source_entries"]
        if not isinstance(ses, list) or len(ses) == 0:
            errors += fail(f"第 {lineno} 行 source_entries 为空")
        else:
            for i, eid in enumerate(ses):
                em = ENTRY_RE.match(eid)
                if not em:
                    errors += fail(f"第 {lineno} 行 source_entries[{i}] '{eid}' 格式不符 <TYPE>-faq-<scenario>")
                else:
                    etype, esc = em.group(1), em.group(2)
                    if etype != personality:
                        errors += fail(f"第 {lineno} 行 source_entries '{eid}' 的 TYPE '{etype}' ≠ personality '{personality}'")
                    if esc != scenario:
                        errors += fail(f"第 {lineno} 行 source_entries '{eid}' 的 scenario '{esc}' ≠ 本条 scenario '{scenario}'")

        # trap 非空
        trap = obj["trap"]
        if not isinstance(trap, str) or not trap.strip():
            errors += fail(f"第 {lineno} 行 trap 为空")
        elif len(trap) < 10:
            errors += fail(f"第 {lineno} 行 trap 过短（<10 字）")

        seen_pairs[(personality, scenario)] += 1

    # 5. 16 × 5 = 80 组合全部恰好出现 1 次
    expected_pairs = {(p, s) for p in PERSONALITIES for s in SCENARIOS}
    missing_pairs = expected_pairs - set(seen_pairs.keys())
    extra_pairs = set(seen_pairs.keys()) - expected_pairs
    dup_pairs = {k: v for k, v in seen_pairs.items() if v != 1}

    if not missing_pairs and not extra_pairs and not dup_pairs:
        ok("16 × 5 = 80 组合各出现 1 次，分布均匀")
    else:
        if missing_pairs:
            errors += fail(f"缺失组合：{sorted(missing_pairs)}")
        if extra_pairs:
            errors += fail(f"非法组合：{sorted(extra_pairs)}")
        if dup_pairs:
            errors += fail(f"重复组合：{dup_pairs}")

    # 6. 按 personality 分布（每型 5 条）
    by_personality = Counter(p for p, _ in seen_pairs.keys())
    bad_p = {k: v for k, v in by_personality.items() if v != 5}
    if not bad_p and len(by_personality) == 16:
        ok("16 人格各 5 条")
    else:
        errors += fail(f"人格分布异常：{bad_p}")

    # 7. 按 scenario 分布（每情境 16 条）
    by_scenario = Counter(s for _, s in seen_pairs.keys())
    bad_s = {k: v for k, v in by_scenario.items() if v != 16}
    if not bad_s and len(by_scenario) == 5:
        ok("5 情境各 16 条")
    else:
        errors += fail(f"情境分布异常：{bad_s}")

    print("=== 汇总 ===")
    if errors == 0:
        print("  全部通过 ✅")
        return 0
    print(f"  失败 {errors} 处 ❌")
    return 1


def main():
    parser = argparse.ArgumentParser(description="评测集 eval/persona_eval.jsonl 合规校验")
    parser.add_argument(
        "path",
        nargs="?",
        default="eval/persona_eval.jsonl",
        help="评测集 jsonl 路径（默认 eval/persona_eval.jsonl）",
    )
    args = parser.parse_args()
    sys.exit(check(Path(args.path)))


if __name__ == "__main__":
    main()
