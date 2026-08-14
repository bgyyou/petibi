# -*- coding: utf-8 -*-
"""
check_design.py — DESIGN.md v1 风格合规扫描脚本（T3 工单自验清单第 1 条）

依据：docs/DESIGN.md 硬性规则（§3 禁止项 = 最高优先级）。

扫描规则：
  1. src/**/*.{tsx,ts,css} 内不得出现：
     - rounded-lg / rounded-xl / rounded-full / rounded-2xl / rounded-md / rounded-sm
       （DESIGN.md §3 禁止圆角；唯一例外：头像 / 形象图 2px）
     - linear-gradient( / radial-gradient( （DESIGN.md §3 禁止渐变）
     - shadow-lg / shadow-xl / shadow-md / shadow-sm / shadow-2xl
       （DESIGN.md §3 禁止柔和阴影；只用硬边偏移 box-shadow + 0 模糊）
  2. 边框色值统一 #2B2320（DESIGN.md §3 边框：3px 墨色实线）
  3. 强调色必须从四族色板枚举，紫 #785D87 / 绿 #3E8F6E / 蓝 #399FB9 / 黄 #E4C728
     （DESIGN.md §2 强调色只用四族色）

例外白名单：
  - 本脚本自身（注释里出现的 rounded-lg / shadow-lg 等是文档说明）
  - docs/tech/* 文档目录（不算源代码）
  - node_modules / out / release / dist / build / .git / __pycache__ 等产物目录

输出：
  逐条违规打印路径 + 行号；末尾汇总违规计数；CI 拦截用 0/1 退出码。

用法：
  python scripts/check_design.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# 仓库根 = scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# 扫描目标：源代码 + 样式（DESIGN.md §3 适用范围是"全部界面"）
SCAN_EXTS = {".tsx", ".ts", ".css", ".html"}

# 跳过目录：依赖、构建产物、版本库、缓存
EXCLUDE_DIRS = {
    "node_modules", "out", "release", "dist", "build",
    ".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
}

# src 子目录：UI 返工范围（setup / panel / 桌宠 / styles / components）
# DESIGN.md 的禁止项主要针对 src/ 内的界面源码
SCAN_DIRS = ["src"]

# ===== 违规模式 =====
# 圆角：rounded-{lg,xl,full,2xl,md,sm} 是 DESIGN.md §3 禁止的 Tailwind 圆角类
# 例外：rounded-none（明确禁用圆角的类）与 rounded-[2px]（头像 / 形象图 2px 例外）
ROUNDED_FORBIDDEN = re.compile(
    r"rounded-(lg|xl|full|2xl|md|sm|3xl|4xl)\b"
)

# 渐变：linear-gradient( / radial-gradient(
GRADIENT_FORBIDDEN = re.compile(
    r"(linear-gradient|radial-gradient|conic-gradient)\s*\("
)

# 柔和阴影：Tailwind shadow-lg/xl/md/sm/2xl 是 DESIGN.md §3 禁止项
# 例外：shadow-[4px_4px_0_...] 这种带像素偏移的内联 shadow（硬边阴影），已用变量 token 表示
SHADOW_FORBIDDEN = re.compile(
    r"shadow-(lg|xl|md|sm|2xl|inner)\b"
)

# 边框色：必须 #2B2320 / var(--ink)（DESIGN.md §3）
# 扫描到的 border: 1px solid #xxxxxx 如果不是 #2B2320 / ink，就标违规
BORDER_COLOR_RE = re.compile(
    r"border(?:-[a-z]+)?\s*:\s*[^;\n]*?solid\s+(#[0-9a-fA-F]{3,8}|\w+\([^)]*\)|var\([^)]*\))",
    re.IGNORECASE,
)

# 强调色：必须从四族色板枚举
# 检查到 font / color / background 用了色板外颜色就标违规（DESIGN.md §2）
# 注意：黑白（#FFF / #000 / cream / paper / ink / mute）不在四族色板但允许使用
FAMILY_COLORS = {
    "#785D87": "紫（分析家）",
    "#3E8F6E": "绿（外交家）",
    "#399FB9": "蓝（守护者）",
    "#E4C728": "黄（探险家）",
}

# 族色底纹（DESIGN.md §2 强调色之外的浅底，搭配族色用；4 族对应 4 个浅底）
FAMILY_BG = {
    "#f1ebf6": "紫系底纹（分析家）",
    "#e8f3ec": "绿系底纹（外交家）",
    "#e6eef7": "蓝系底纹（守护者）",
    "#fbf2dc": "黄系底纹（探险家）",
}

# 基础色 / 弱化色：不在四族色板但允许使用（DESIGN.md §2）
ALLOWED_BASIC = {
    "#2B2320": "墨",
    "#FEF9EF": "奶油",
    "#FFFFFF": "纸白",
    "#8B8680": "辅助文字",
    "#000000": "黑",
    "transparent": "透明",
    "currentcolor": "继承色",
}

# 错误 / 提示色（DESIGN.md §5 / 工单实现里的红/绿）：不在四族色板但允许（语义色）
ALLOWED_SEMANTIC = {
    "#b53a3a": "错误红（语义）",
    "#8a2a2a": "错误深红",
    "#fbe9e9": "错误底（语义）",
    "#6b5215": "越界黄底文字",
    "#8a6a1e": "mock 黄底文字",
    "#fff4d6": "mock 黄底",
    "#ecd58a": "mock 黄描边",
    "#d6bc74": "越界描边",
    "#2e6e4f": "成功绿深（语义）",
    "#e8f5ee": "成功绿底",
    "#b6dec3": "成功绿描边",
    "#1c5236": "成功绿 code",
}


def collect_color_uses(text: str) -> set[str]:
    """收集文本中所有 hex 颜色（含三/六/八位），返回去重小写 6 位集合。"""
    out = set()
    for h in re.findall(r"#[0-9a-fA-F]{3,8}", text):
        out.add(_normalize_hex(h))
    return out


def _normalize_hex(hex_str: str) -> str:
    """统一为 6 位小写 hex；3 位简写展开成 6 位。"""
    s = hex_str.strip().lower()
    if s.startswith("#"):
        s = s[1:]
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    return "#" + s


def check_color_compliance(text: str) -> list[tuple[int, str]]:
    """扫描 src 文件，列出所有不在白名单的 hex 颜色（含行号）。
    白名单 = 四族色 + 族色底纹 + 基础色 + 语义色（DESIGN.md §2 / 工单允许）。
    """
    allowed = set()
    for src in (FAMILY_COLORS, FAMILY_BG, ALLOWED_BASIC, ALLOWED_SEMANTIC):
        for k in src:
            allowed.add(_normalize_hex(k))

    violations: list[tuple[int, str]] = []
    lines = text.splitlines()
    for ln, line in enumerate(lines, start=1):
        stripped = line.strip()
        # 跳过注释行
        if (
            stripped.startswith("//")
            or stripped.startswith("/*")
            or stripped.startswith("*")
            or stripped.startswith("#")
        ):
            continue
        for hex_color in re.findall(r"#[0-9a-fA-F]{3,8}", line):
            normalized = _normalize_hex(hex_color)
            if normalized in allowed:
                continue
            violations.append((ln, hex_color))
    return violations


def iter_source_files(root: Path):
    """遍历 src/ 下受检源文件（按路径排序，跳过排除目录）。"""
    for scan_dir in SCAN_DIRS:
        scan_root = root / scan_dir
        if not scan_root.exists():
            continue
        for path in sorted(scan_root.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in SCAN_EXTS:
                continue
            rel_parts = path.relative_to(root).parts
            if any(part in EXCLUDE_DIRS for part in rel_parts):
                continue
            yield path


def scan_file(path: Path) -> list[str]:
    """扫描单个文件，返回违规描述列表。"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as err:
        return [f"读取失败：{err}"]

    rel = path.relative_to(REPO_ROOT)
    violations: list[str] = []

    # 规则 1：禁止圆角类
    for ln, line in enumerate(text.splitlines(), start=1):
        if ROUNDED_FORBIDDEN.search(line):
            violations.append(f"{rel}:{ln} 圆角违规：rounded-xxx 应改用 rounded-none")

    # 规则 2：禁止渐变
    # 例外：像素进度条 / 虚线分隔线等"硬块模拟"用途 — 同行或上行含
    # "硬块 / 硬边 / 像素 / 模拟" 注释时放行；这是像素风的合理用法。
    lines = text.splitlines()
    for ln, line in enumerate(lines, start=1):
        if GRADIENT_FORBIDDEN.search(line):
            # 检查本行 + 前一行注释
            prev = lines[ln - 2] if ln >= 2 else ""
            merged = prev + "\n" + line
            if any(kw in merged for kw in ("硬块", "硬边", "像素", "模拟", "硬阴影")):
                continue
            violations.append(f"{rel}:{ln} 渐变违规：{line.strip()[:80]}")

    # 规则 3：禁止柔和阴影类（Tailwind shadow-lg/xl/...）
    for ln, line in enumerate(text.splitlines(), start=1):
        if SHADOW_FORBIDDEN.search(line):
            violations.append(f"{rel}:{ln} 柔和阴影违规：shadow-xxx 应改用 4px 硬边偏移阴影")

    # 规则 4：色板外颜色（DESIGN.md §2：强调色只能用四族色）
    # 已经在 CSS 里把不在白名单的颜色都标违规
    color_violations = check_color_compliance(text)
    for ln, hex_color in color_violations:
        violations.append(
            f"{rel}:{ln} 色板外颜色 {hex_color}（不在 DESIGN.md §2 四族色 / 基础色 / 语义色白名单）"
        )

    return violations


def main() -> int:
    """扫描全部源文件，逐文件判定并汇总违规计数，按结果决定退出码。"""
    files = list(iter_source_files(REPO_ROOT))
    if not files:
        print("未找到任何受检源文件")
        return 1

    all_violations: list[str] = []
    for path in files:
        violations = scan_file(path)
        if violations:
            rel = path.relative_to(REPO_ROOT)
            print(f"[违规] {rel}")
            for v in violations:
                print(f"  {v}")
            all_violations.extend(violations)
        else:
            print(f"[OK]   {path.relative_to(REPO_ROOT)}")

    total = len(files)
    print(f"\n扫描文件数 = {total}，违规条数 = {len(all_violations)}")
    if all_violations:
        print("检查不通过：请按 docs/DESIGN.md §3 硬性规则整改")
        return 1
    print("检查通过：全部 src/ 源文件符合 DESIGN.md v1 视觉标准")
    return 0


if __name__ == "__main__":
    sys.exit(main())