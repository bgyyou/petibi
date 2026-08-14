# -*- coding: utf-8 -*-
"""
apply_entry_dedup_patches.py — 按 id 覆写百科条目 content（全类目去重改写用）

输入：一个 JSON 补丁文件，形如
  {
    "ENFJ": { "ENFJ-trait-01": "新的正文……", "ENFJ-faq-conflict": "……" },
    "INTJ": { ... }
  }

行为：
  · 只改 content 字段，不动 id/category/title/tags/scenario，不增删条目；
  · 保持原文件的 2 空格缩进 + ensure_ascii=False + CRLF 行尾，diff 只落在被改的行；
  · 找不到的 id 直接报错退出（防止补丁写错 id 静默失效）。

用法：
  python scripts/apply_entry_dedup_patches.py patches/xxx.json
  python scripts/apply_entry_dedup_patches.py patches/xxx.json --dry-run
"""
import argparse
import io
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"


def load_raw(path):
    return io.open(path, encoding="utf-8", newline="").read()


def dump_raw(path, data, use_crlf):
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if use_crlf:
        text = text.replace("\n", "\r\n")
    io.open(path, "w", encoding="utf-8", newline="").write(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("patch", help="补丁 JSON 路径")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    patches = json.loads(Path(args.patch).read_text(encoding="utf-8"))
    total = 0
    for personality, id_map in patches.items():
        fpath = ENCYCLOPEDIA_DIR / f"{personality.lower()}.json"
        if not fpath.exists():
            print(f"FAIL 文件不存在：{fpath}")
            return 1
        raw = load_raw(fpath)
        use_crlf = "\r\n" in raw
        data = json.loads(raw)
        by_id = {e["id"]: e for e in data["entries"]}
        missing = [k for k in id_map if k not in by_id]
        if missing:
            print(f"FAIL {personality} 补丁含未知 id：{missing}")
            return 1
        for eid, content in id_map.items():
            old = by_id[eid]["content"]
            if old != content:
                by_id[eid]["content"] = content
                total += 1
                print(f"  ~ {eid}  {len(old)}字 → {len(content)}字")
        if not args.dry_run:
            dump_raw(fpath, data, use_crlf)
        print(f"{personality}: 应用 {len(id_map)} 条补丁"
              f"{'（dry-run，未写盘）' if args.dry_run else ''}")

    print(f"\n合计改写 {total} 条 content。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
