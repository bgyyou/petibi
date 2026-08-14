# -*- coding: utf-8 -*-
"""fix_round17_damage.py — 清除 round 17 引入的 "的又的" 等异常插入。

策略：从每个受影响 entry 的 content 中，按 round 17 的插入规则反向清理：
- 删除无意义的 "的又" / "的又的" / "又的又" / "又的" 序列
- 恢复 round 17 之前的状态
"""

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"


def load_entry(p, eid):
    fpath = ENCYCLOPEDIA_DIR / f"{p.lower()}.json"
    data = json.loads(fpath.read_text(encoding="utf-8"))
    for e in data["entries"]:
        if e["id"] == eid:
            return e, data
    return None, None


def save_entry(p, data):
    fpath = ENCYCLOPEDIA_DIR / f"{p.lower()}.json"
    fpath.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


# 清理规则：把 round 17 引入的多余字删掉
# 模式 1: "的又的" → "的" (因为 round 17 重复插入)
# 模式 2: "又的又" → ""
# 模式 3: "的又" → ""
# 模式 4: "又的" → ""
# 但是这些要慎重 — 真的出现"又"字有意义的情况
# 看数据：round 17 的 INSERTABLE_CHARS 包括 '又'，所以 "又" 是被插入的噪声
# 但 entry 内容本来可能有 "又" 字有意义（"又...又..."）


def clean_damage(text):
    """删除 round 17 引入的 '的又的' / '又的又' 序列。"""
    # 先删重复组合
    while "的又的又" in text:
        text = text.replace("的又的又", "")
    while "又的又的" in text:
        text = text.replace("又的又的", "")
    while "的又的" in text:
        text = text.replace("的又的", "的")
    while "又的又" in text:
        text = text.replace("又的又", "")
    # 处理单独的 "的又" 或 "又的"
    # '又' 是 round 17 INSERTABLE 的字符；正常 entry 里有意义的 '又' 通常是 '又...又...' 结构
    # 简单处理：删除出现在词中间的孤立 '又'
    # 但要避免破坏 "又" 在正常位置
    # 启发式：如果 '的又' 后接 1-2 个字 + '的'，那 "又" 是插入的
    # 更稳妥：用 lookbehind/ahead 删 "的又" 但 "又" 后必须是字
    text = re.sub(r"的又(?=[一-龥])", "的", text)
    text = re.sub(r"(?<=[一-龥])又的", "", text)
    return text


def main():
    changed = 0
    affected = 0
    for fn in ENCYCLOPEDIA_DIR.glob("*.json"):
        if fn.name in ("index.json", "scenarios.md"):
            continue
        data = json.loads(fn.read_text(encoding="utf-8"))
        p = data["personality"]
        file_changed = False
        for e in data["entries"]:
            cur = e["content"]
            if "的又的" not in cur and "又的又" not in cur:
                continue
            affected += 1
            new = clean_damage(cur)
            if new != cur:
                e["content"] = new
                file_changed = True
                changed += 1
        if file_changed:
            save_entry(p, data)

    print(f"检查条目: {affected} 受影响, 修改: {changed}")


if __name__ == "__main__":
    main()