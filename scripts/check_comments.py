# -*- coding: utf-8 -*-
"""
check_comments.py — 中文文件头注释覆盖率检查脚本（红线 R9 / M1 工单验收第 5 条）

规则：
  仓库内每个 .ts / .tsx / .py / .js 源文件，前 5 行内必须出现
  "含中文字符的注释行"（即中文文件头注释，说明本文件用途）。

判定细节：
  - 注释标记兼容各语言：// 、/* */ 块内行、# 、三引号 docstring、<!-- -->
  - 中文字符判定：CJK 统一表意文字区间 \\u4e00-\\u9fff
  - 排除目录：node_modules / out / release / dist / build / .git / __pycache__ 等产物目录

输出：
  逐文件打印 OK / 缺失；末尾汇总覆盖率。

退出码：
  覆盖率 100% → 0（供 CI / 验收拦截用）；否则 → 1。

用法：
  python scripts/check_comments.py
"""

import re
import sys
from pathlib import Path

# 仓库根目录 = 本文件所在 scripts/ 的上一级，保证从任意工作目录运行都扫同一批文件
REPO_ROOT = Path(__file__).resolve().parent.parent

# 需要检查的源文件后缀（工单验收第 5 条约定）
SCAN_EXTS = {".ts", ".tsx", ".py", ".js"}

# 跳过目录：依赖、构建产物、版本库、缓存，这些不是项目源代码
EXCLUDE_DIRS = {
    "node_modules", "out", "release", "dist", "build",
    ".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
}

# 文件头判定窗口：只看前 5 行
HEADER_LINES = 5

# CJK 统一表意文字（常用汉字区间）
CJK_RE = re.compile(r"[\u4e00-\u9fff]")

# 各语言的注释标记：命中其一即视为注释行
COMMENT_MARKS = ("//", "/*", "#", '"""', "'''", "<!--")


def has_chinese_header(path):
    """检查单个文件前 5 行内是否存在中文文件头注释。读取失败按缺失处理。

    判定方式（两段式，兼容 docstring / 块注释中间行没有注释标记的情况）：
      1. 前 5 行里至少一行含中文（CJK 区间字符）；
      2. 前 5 行里至少一行带注释标记（//、#、/*、三引号等）或以 * 开头（块注释续行），
         以证明这些中文确实写在注释里，而不是普通字符串。
    """
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[:HEADER_LINES]
    except OSError:
        return False
    has_chinese = any(CJK_RE.search(line) for line in lines)
    has_comment_mark = any(
        any(mark in line for mark in COMMENT_MARKS) or line.strip().startswith("*")
        for line in lines
    )
    return has_chinese and has_comment_mark


def iter_source_files(root):
    """遍历仓库内全部受检源文件（按路径排序，跳过排除目录）。"""
    for path in sorted(root.rglob("*")):
        # 只处理文件，且后缀在受检清单内
        if not path.is_file() or path.suffix.lower() not in SCAN_EXTS:
            continue
        # 路径任一段命中排除目录名即跳过（相对路径判定，兼容任意运行目录）
        rel_parts = path.relative_to(root).parts
        if any(part in EXCLUDE_DIRS for part in rel_parts):
            continue
        yield path


def main():
    """扫描全部源文件，逐文件判定并汇总覆盖率，按结果决定退出码。"""
    files = list(iter_source_files(REPO_ROOT))
    if not files:
        print("未找到任何受检源文件")
        return 1

    missing = []
    for path in files:
        rel = path.relative_to(REPO_ROOT)
        if has_chinese_header(path):
            print(f"[OK] {rel}")
        else:
            print(f"[缺失] {rel}：前 {HEADER_LINES} 行内无中文文件头注释")
            missing.append(rel)

    total = len(files)
    passed = total - len(missing)
    print(f"中文文件头覆盖率 = {passed}/{total}")
    if missing:
        print("检查不通过：请为上述文件补充中文文件头注释（红线 R9）")
        return 1
    print("检查通过：全部源文件均有中文文件头注释")
    return 0


if __name__ == "__main__":
    sys.exit(main())
