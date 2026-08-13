# -*- coding: utf-8 -*-
"""
tmp_list_missing_teamwork.py — 临时脚本：列出 eval/persona_eval.jsonl 中
所有 source_entries 引用但 data/encyclopedia/ 里不存在的条目 id，
按"百科库按人格分配场景 vs 评测集假设 5 高频 × 16 人格全覆盖"的缺口来定位。

运行：
    python scripts/tmp_list_missing_teamwork.py
"""
import json
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
ENC_DIR = REPO_ROOT / "data" / "encyclopedia"
EVAL_PATH = REPO_ROOT / "eval" / "persona_eval.jsonl"


def main() -> int:
    # 1. 百科库所有条目 id
    enc_ids = set()
    for p in ENC_DIR.glob("*.json"):
        if p.name == "index.json":
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        for e in data.get("entries", []):
            enc_ids.add(e["id"])

    # 2. 评测集 source_entries 全部引用 + 缺失集合
    refs = []
    missing = []
    with EVAL_PATH.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            for sid in rec.get("source_entries", []):
                refs.append((rec["id"], rec["personality"], sid))
                if sid not in enc_ids:
                    missing.append(sid)

    miss_set = sorted(set(missing))
    print(f"评测集 source_entries 总引用：{len(refs)}")
    print(f"百科库条目 id 总数：        {len(enc_ids)}")
    print(f"缺失条目（去重）：          {len(miss_set)}")
    print()
    print("缺失清单（按 id 排序）：")
    for m in miss_set:
        print(f"  - {m}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())