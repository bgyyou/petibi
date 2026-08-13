# -*- coding: utf-8 -*-
"""
check_questions.py — M2 题库结构、方向分布、溯源、16 型可达与敏感措辞检查。

本脚本只读取 data/questions/questions.json，不修改题库。命令：
python scripts/check_questions.py
全部检查通过时退出码为 0；否则输出失败原因并返回 1。
"""
import itertools
import json
import re
import sys
from collections import Counter
from pathlib import Path


# 仓库根目录固定为脚本所在目录的上一级。
REPO_ROOT = Path(__file__).resolve().parent.parent
QUESTION_PATH = REPO_ROOT / "data" / "questions" / "questions.json"

# 契约 §1 规定的五维度及双向取值。
DIRECTION_SETS = {
    "EI": ("E", "I"),
    "SN": ("S", "N"),
    "TF": ("T", "F"),
    "JP": ("J", "P"),
    "ES": ("stable", "sensitive"),
}

# 16 型遍历时，四个主线维度的第一位与第二位顺序由主维度顺序固定。
TYPE_DIMENSIONS = ("EI", "SN", "TF", "JP")
EXPECTED_TOTAL = 40
EXPECTED_ID_PATTERN = re.compile(r"^[A-Z]{2}(0[1-8])$")

# 候选标志性措辞仅用于抽查，不替代完整版权审查。
SENSITIVE_MARKERS = (
    "你从哪里获得能量",
    "你如何恢复精力",
    "观察细节还是理解抽象概念",
    "根据逻辑和一致性做决定",
    "根据价值和和谐做决定",
    "你倾向于通过事实理解世界",
    "你倾向于通过想象理解世界",
    "固定偏好",
    "每一种人格类型",
    "这是你的类型报告",
)

# 题目内容禁止使用的明显社会期许诱导词。
SOCIAL_DESIRABILITY_MARKERS = ("懒", "笨", "愚蠢")


def load_question_bank():
    """读取题库 JSON，并返回完整题库对象。"""
    try:
        with QUESTION_PATH.open("r", encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"题库读取失败：{error}") from error


def collect_questions(bank):
    """从题库对象中提取题目列表，并统一转换为可比较的字典集合。"""
    questions = bank.get("questions")
    if not isinstance(questions, list):
        raise RuntimeError("questions 必须是数组")
    return questions


def validate_basic_schema(bank, questions):
    """检查版本、维度数组、题量、必填字段、方向和溯源字段。"""
    if bank.get("version") != "1.0":
        raise RuntimeError("version 必须为 1.0")
    if bank.get("dimensions") != list(DIRECTION_SETS):
        raise RuntimeError("dimensions 顺序或内容不符合契约 §1")
    if len(questions) != EXPECTED_TOTAL:
        raise RuntimeError(f"题数必须为 {EXPECTED_TOTAL}，实际为 {len(questions)}")
    if not all(isinstance(question, dict) for question in questions):
        raise RuntimeError("每道题必须是 JSON 对象")

    required_fields = {"id", "dimension", "direction", "text", "source", "source_ref"}
    ids = []
    for question in questions:
        # 先确认字段完整，避免后续比较因空字段而误报。
        missing_fields = required_fields - question.keys()
        if missing_fields:
            missing = ", ".join(sorted(missing_fields))
            raise RuntimeError(f"题目缺少字段：{missing}")
        if not isinstance(question["id"], str) or not EXPECTED_ID_PATTERN.fullmatch(question["id"]):
            raise RuntimeError(f"非法 id：{question['id']!r}")
        ids.append(question["id"])
        dimension = question["dimension"]
        direction = question["direction"]
        if dimension not in DIRECTION_SETS:
            raise RuntimeError(f"非法 dimension：{dimension!r}")
        if direction not in DIRECTION_SETS[dimension]:
            raise RuntimeError(f"非法 direction：{direction!r}")
        if not all(isinstance(question[key], str) and question[key].strip() for key in ("text", "source_ref")):
            raise RuntimeError(f"题目 {question['id']} 的 text/source_ref 不能为空")
        if question["source"] != "IPIP":
            raise RuntimeError(f"题目 {question['id']} 的 source 必须是 IPIP")
    if len(ids) != len(set(ids)):
        raise RuntimeError("id 必须唯一")


def validate_distribution(questions):
    """检查每维恰好 8 题，且第一极与第二极各 4 题。"""
    counts = Counter(question["dimension"] for question in questions)
    direction_counts = {}
    for dimension in DIRECTION_SETS:
        if counts[dimension] != 8:
            raise RuntimeError(f"{dimension} 题数必须为 8，实际为 {counts[dimension]}")
        first_direction, second_direction = DIRECTION_SETS[dimension]
        # 逐维统计双极题目，确保四个维度都满足 4:4，而不是只做全局平均。
        dimension_questions = [question for question in questions if question["dimension"] == dimension]
        observed = Counter(question["direction"] for question in dimension_questions)
        direction_counts[dimension] = (observed[first_direction], observed[second_direction])
        if direction_counts[dimension] != (4, 4):
            raise RuntimeError(
                f"{dimension} 方向分布必须为 4:4，实际为 {direction_counts[dimension]}"
            )
    return direction_counts


def validate_reachability(question_by_id):
    """遍历四维各取第一极或第二极，验证 16 种主线类型全部可达。"""
    reachable = set()
    all_questions = [question for questions in question_by_id.values() for question in questions]
    for type_bits in itertools.product((0, 1), repeat=len(TYPE_DIMENSIONS)):
        # 每个维度全选第一极时给 5 分，全选第二极时给 1 分。
        answers = {}
        for question in all_questions:
            answers[question["id"]] = 1
        for dimension, bit in zip(TYPE_DIMENSIONS, type_bits):
            selected_direction = DIRECTION_SETS[dimension][bit]
            for question in question_by_id[dimension]:
                if question["direction"] == selected_direction:
                    answers[question["id"]] = 5
        # 按数据契约计算 0–100 维度百分比，确保不是只数题目方向。
        letters = []
        for dimension in TYPE_DIMENSIONS:
            first_direction, second_direction = DIRECTION_SETS[dimension]
            total = sum(
                (answers[question["id"]] - 1)
                if question["direction"] == first_direction
                else (5 - answers[question["id"]])
                for question in question_by_id[dimension]
            )
            percentage = total / (len(question_by_id[dimension]) * 4) * 100
            if percentage not in (0, 100):
                raise RuntimeError(f"{dimension} 全极答案未形成 0/100 百分比")
            letters.append(first_direction if percentage >= 50 else second_direction)
        reachable.add("".join(letters))
    expected_types = {
        "".join(
            DIRECTION_SETS[dimension][bit]
            for dimension, bit in zip(TYPE_DIMENSIONS, type_bits)
        )
        for type_bits in itertools.product((0, 1), repeat=len(TYPE_DIMENSIONS))
    }
    if reachable != expected_types or len(reachable) != 16:
        raise RuntimeError("可达类型不为 16 种")
    return reachable


def validate_text_safety(questions):
    """扫描题干的明显诱导词和候选版权标志性措辞。"""
    texts = "\n".join(question["text"] for question in questions)
    hits = []
    # 合并两类标记，输出命中的原词和题目编号便于定位。
    all_markers = SOCIAL_DESIRABILITY_MARKERS + SENSITIVE_MARKERS
    for marker in all_markers:
        if marker in texts:
            hits.append(marker)
    if hits:
        raise RuntimeError("题干命中敏感标记：" + ", ".join(hits))


def print_summary(direction_counts, reachable):
    """输出固定格式的交付验收摘要。"""
    print("[通过] JSON 合法；版本与维度字段符合契约 §1")
    print("[通过] 题目总数 = 40")
    for dimension in DIRECTION_SETS:
        first_direction, second_direction = DIRECTION_SETS[dimension]
        print(
            f"[通过] {dimension} = 8 题；{first_direction}/{second_direction} = "
            f"{direction_counts[dimension][0]}/{direction_counts[dimension][1]}"
        )
    print("[通过] id 唯一；source/source_ref 非空；source 均为 IPIP")
    print(f"[通过] 16 型可达 = {len(reachable)}/16")
    print("[通过] 社会期许词命中 = 0")
    print("[通过] 官方/16Personalities 候选标志性措辞命中 = 0")


def main():
    """执行题库全部检查，并在任一检查失败时返回非零退出码。"""
    bank = load_question_bank()
    questions = collect_questions(bank)
    validate_basic_schema(bank, questions)
    direction_counts = validate_distribution(questions)
    question_by_id = {dimension: [] for dimension in DIRECTION_SETS}
    for question in questions:
        # 按维度建立索引，供可达性遍历和方向统计复用。
        question_by_id[question["dimension"]].append(question)
    reachable = validate_reachability(question_by_id)
    validate_text_safety(questions)
    print_summary(direction_counts, reachable)
    print("[通过] 题库自检完成")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(f"[失败] {error}")
        sys.exit(1)
