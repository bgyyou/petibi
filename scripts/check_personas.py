#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_personas.py — 校验 MBTI 人格、拒绝模板与意图词库资产。"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PERSONAS_DIR = REPO_ROOT / "data" / "personas"
PERSONA_TYPES = [
    "INTJ", "INTP", "ENTJ", "ENTP",
    "INFJ", "INFP", "ENFJ", "ENFP",
    "ISTJ", "ISFJ", "ESTJ", "ESFJ",
    "ISTP", "ISFP", "ESTP", "ESFP",
]
# 类别清单不再硬编码：改从 data/intent-filter.json 动态读取（注入类 inject 单独放宽上限）
INJECT_CATEGORY = "inject"
INJECT_MAX_KEYWORDS = 60
DEFAULT_MIN_KEYWORDS = 8
DEFAULT_MAX_KEYWORDS = 15
PROMPT_SECTIONS = ["【身份】", "【风格】", "【认知】", "【边界】", "【禁止】"]
FORBIDDEN_STARTS = ("对不起", "我无法")
TALK_HOOKS = (
    "聊", "说", "问", "听", "陪", "回", "来", "一起", "开始", "继续", "放下",
    "交给我", "目标", "卡点", "条件", "题目", "数据", "来源", "需求", "时间", "期限",
    "计划", "顾虑", "结果", "标准", "步骤", "方向", "限制", "问题", "情境", "感受",
    "困惑", "想法", "需要", "交给", "发来", "列出", "给出", "提供", "整理", "判断",
    "决定", "选择", "安排", "初心", "尝试", "行动", "素材", "主题", "角色", "情境",
    "哪些", "哪个", "模板",
)


def load_json(path):
    """读取 UTF-8 JSON 文件并在格式错误时给出明确路径。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AssertionError(f"无法读取 JSON：{path.relative_to(REPO_ROOT)}：{exc}") from exc


def load_animal_map():
    """从 palette.json 读取人格→动物名映射，作为 pet_name 校验基准。"""
    palette = load_json(REPO_ROOT / "assets" / "style" / "palette.json")
    personalities = palette.get("personalities", {})
    return {mbti: info["animal"] for mbti, info in personalities.items() if isinstance(info, dict)}


def validate_personas(errors):
    """校验 16 张五段式人格速查卡及桌宠名唯一性。"""
    actual_files = {path.stem.lower() for path in PERSONAS_DIR.glob("*.json")}
    expected_files = {mbti_type.lower() for mbti_type in PERSONA_TYPES}
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        extra = sorted(actual_files - expected_files)
        if missing:
            errors.append(f"人格文件缺失：{', '.join(missing)}")
        if extra:
            errors.append(f"人格文件多余：{', '.join(extra)}")

    pet_names = set()
    seen_prompts = set()
    animal_map = load_animal_map()
    for mbti_type in PERSONA_TYPES:
        path = PERSONAS_DIR / f"{mbti_type.lower()}.json"
        if not path.exists():
            continue
        data = load_json(path)
        required = {"type", "pet_name", "animal", "family", "system_prompt", "cognitive", "style_keywords"}
        missing = required - data.keys()
        if missing:
            errors.append(f"{mbti_type} 缺少字段：{', '.join(sorted(missing))}")
            continue
        if data["type"] != mbti_type:
            errors.append(f"{mbti_type} 的 type 字段为 {data['type']!r}")
        expected_animal = animal_map.get(mbti_type)
        if data["pet_name"] != expected_animal:
            errors.append(f"{mbti_type} pet_name 应等于 palette.animal {expected_animal!r}，实际 {data['pet_name']!r}")
        if data["animal"] != expected_animal:
            errors.append(f"{mbti_type} animal 字段与 palette 不一致：{data['animal']!r} vs {expected_animal!r}")
        if not re.fullmatch(r"[\u4e00-\u9fff]+", data["pet_name"]):
            errors.append(f"{mbti_type} 的 pet_name 不是纯中文字符：{data['pet_name']!r}")
        if data["pet_name"] in pet_names:
            errors.append(f"pet_name 重名：{data['pet_name']}")
        pet_names.add(data["pet_name"])

        prompt = data["system_prompt"]
        if not isinstance(prompt, str) or len(prompt) > 200:
            errors.append(f"{mbti_type} system_prompt 长度 {len(prompt) if isinstance(prompt, str) else 'N/A'} > 200")
        for section in PROMPT_SECTIONS:
            if section not in prompt:
                errors.append(f"{mbti_type} system_prompt 缺少 {section}")
        if prompt in seen_prompts:
            errors.append(f"system_prompt 重复：{mbti_type}")
        seen_prompts.add(prompt)
    return len(pet_names)


def validate_refusals(errors):
    """校验 16×5×2 条拒绝模板的长度、语气与聊天收尾。
    拒绝模板的 5 类仍为硬编码（与历史数据契约一致），意图词库类别则动态读取。
    """
    refusal_categories = ["code", "homework", "generate", "web", "roleplay"]
    path = REPO_ROOT / "data" / "refusals.json"
    data = load_json(path)
    if data.get("categories") != refusal_categories:
        errors.append(f"refusals.categories 不符：{data.get('categories')}")
    templates = data.get("templates", {})
    if set(templates) != set(PERSONA_TYPES):
        errors.append("拒绝模板的人格集合不是完整 16 型")
        return 0

    entries = []
    for mbti_type in PERSONA_TYPES:
        persona_refusals = templates[mbti_type]
        if set(persona_refusals) != set(refusal_categories):
            errors.append(f"{mbti_type} 拒绝类别集合不符")
            continue
        for category in refusal_categories:
            variants = persona_refusals[category]
            if not isinstance(variants, list) or len(variants) != 2:
                errors.append(f"{mbti_type}/{category} 应有 2 条变体")
                continue
            for index, template in enumerate(variants, 1):
                entries.append(template)
                if not isinstance(template, str) or not template.strip():
                    errors.append(f"{mbti_type}/{category}/#{index} 为空")
                    continue
                if len(template) > 80:
                    errors.append(f"{mbti_type}/{category}/#{index} 长度 {len(template)} > 80")
                if template.startswith(FORBIDDEN_STARTS):
                    errors.append(f"{mbti_type}/{category}/#{index} 使用禁止开头：{template[:8]}")
                if not any(hook in template for hook in TALK_HOOKS):
                    errors.append(f"{mbti_type}/{category}/#{index} 缺少回聊引导")
    if len(set(entries)) != 160:
        errors.append(f"拒绝模板去重后为 {len(set(entries))} 条，预期 160 条")
    return len(entries)


def validate_intent_filter(errors):
    """校验意图词库：类别从 data/intent-filter.json 动态读取，关键词数 inject 类放宽到 60，其余 8-15。"""
    path = REPO_ROOT / "data" / "intent-filter.json"
    data = load_json(path)
    rules = data.get("rules", [])
    actual_categories = [rule.get("category") for rule in rules if isinstance(rule, dict)]
    # 类别清单动态读取，不再硬编码比较；至少要含五大类 + inject
    required = {"code", "homework", "generate", "web", "roleplay", INJECT_CATEGORY}
    missing_required = required - set(actual_categories)
    if missing_required:
        errors.append(f"意图规则缺少必备类别：{sorted(missing_required)}")
    keyword_total = 0
    for rule in rules:
        category = rule.get("category")
        keywords = rule.get("keywords")
        # inject 类放宽到 60，其余 8-15
        is_inject = category == INJECT_CATEGORY
        min_kw = 1 if is_inject else DEFAULT_MIN_KEYWORDS
        max_kw = INJECT_MAX_KEYWORDS if is_inject else DEFAULT_MAX_KEYWORDS
        if not isinstance(keywords, list) or not min_kw <= len(keywords) <= max_kw:
            errors.append(
                f"意图类别 {category} 关键词数为 "
                f"{len(keywords) if isinstance(keywords, list) else 'N/A'}，"
                f"预期 {min_kw}-{max_kw}"
            )
        elif len(keywords) != len(set(keywords)):
            errors.append(f"意图类别 {category} 含重复关键词")
        if rule.get("action") != "refuse":
            errors.append(f"意图类别 {category} action 不是 refuse")
        keyword_total += len(keywords) if isinstance(keywords, list) else 0
    skip_patterns = data.get("rag_skip_patterns", [])
    if not skip_patterns or len(skip_patterns) != len(set(skip_patterns)):
        errors.append("rag_skip_patterns 为空或含重复项")
    return keyword_total


def print_cards():
    """打印全部 16 张速查卡正文，供主 agent 并排终审。"""
    print("\n=== 16 张人格速查卡（正文）===")
    for mbti_type in PERSONA_TYPES:
        path = PERSONAS_DIR / f"{mbti_type.lower()}.json"
        if not path.exists():
            continue
        data = load_json(path)
        print(f"\n[{mbti_type}] {data['pet_name']}｜{data['animal']}｜{data['family']}")
        print(data["system_prompt"])


def main():
    """执行全部资产校验，打印差异抽查并以非零状态报告失败。"""
    errors = []
    persona_count = validate_personas(errors)
    refusal_count = validate_refusals(errors)
    keyword_count = validate_intent_filter(errors)
    print("=== M3 人格资产自检 ===")
    print(f"人格文件：{persona_count}/16；拒绝模板：{refusal_count}/160；意图关键词：{keyword_count}（inject≤60，其余 8-15）")
    if errors:
        print("检查不通过：")
        for error in errors:
            print(f"- {error}")
        return 1
    print("结构、数量、长度、唯一性、语气开头、回聊引导及词库数量检查通过")
    print_cards()
    print("\n检查通过：全部 M3 人格资产符合契约")
    return 0


if __name__ == "__main__":
    sys.exit(main())
