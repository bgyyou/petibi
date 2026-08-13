# -*- coding: utf-8 -*-
"""
make_characters.py — 16 人格兽首人身 sprite 程序化像素绘制（工单第 3 步保底 / 实际生产线）

设计依据：assets/style/character-design.md（本文件实现其中的坐标与用色规范）。

核心结构：
  - 32×32 画布，2px 边距；内容包围盒严格 y2..29（高 28），宽 ≤ 28 且左右对称——
    这样再过 pixelate.py（--size 32）时缩放比恒为 1、居中偏移不变，是恒等变换，
    不会被二次缩放破坏逐像素设计，两帧呼吸差也不会被居中重排吃掉
  - 16 只共用一副人类身体骨架（躯干/手臂/腿坐标完全一致），只换动物头 + 衣服配色
  - idle 2 帧：帧 1 躯干和手臂下移 1px（腿被压短 1px，头和脚不动），即呼吸起伏
  - 描边由"剪影膨胀一圈 - 剪影"自动生成，统一 1px #2B2320，不会断边
  - 全部颜色取自 assets/style/palette.json（16 族色 + outline），alpha 只有 0/255

用法：
  python scripts/make_characters.py            # 生成 16 只 × idle 2 帧
  python scripts/make_characters.py --sheet    # 额外拼 16 宫格 assets/art/sprite-sheet.png

依赖：仅 Pillow。
"""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# 输出目录：resources/sprites/<人格小写>/idle_0.png, idle_1.png
SPRITES_DIR = REPO_ROOT / "resources" / "sprites"

# 16 宫格目检图输出位置（assets/art/ 已 gitignore，供 owner 目检用）
SHEET_PATH = REPO_ROOT / "assets" / "art" / "sprite-sheet.png"

CANVAS = 32          # 画布边长（PRD §8.4：32×32）
OUTLINE_HEX = "#2B2320"  # 统一描边色（palette.json outline）


def hex2rgb(h):
    """'#RRGGBB' → (R, G, B) 元组。"""
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


OUTLINE = hex2rgb(OUTLINE_HEX)

# 四族色板（与 assets/style/palette.json 一致，由深到浅）
FAMILIES = {
    "analyst": ["#3B2A4A", "#6B4E8E", "#9B7EC4", "#C9B4E0"],
    "diplomat": ["#1F4433", "#3E7C59", "#6FAF88", "#A8D5BA"],
    "sentinel": ["#1F3A5F", "#33608F", "#5B8FC7", "#9DC3E6"],
    "explorer": ["#6B4A1F", "#A8763E", "#D4A55F", "#F0CE9B"],
}

# 人格 → (族, 族内主色档位 0..3)。与 palette.json personalities 一一对应
PERSONALITY_FAMILY = {
    "intj": ("analyst", 0), "intp": ("analyst", 1),
    "entj": ("analyst", 2), "entp": ("analyst", 3),
    "infj": ("diplomat", 0), "infp": ("diplomat", 1),
    "enfj": ("diplomat", 2), "enfp": ("diplomat", 3),
    "istj": ("sentinel", 0), "isfj": ("sentinel", 1),
    "estj": ("sentinel", 2), "esfj": ("sentinel", 3),
    "istp": ("explorer", 0), "isfp": ("explorer", 1),
    "estp": ("explorer", 2), "esfp": ("explorer", 3),
}

# 人格在 16 宫格里的排列顺序（按族分行：分析家/外交家/守护者/探险家）
SHEET_ORDER = [
    "intj", "intp", "entj", "entp",
    "infj", "infp", "enfj", "enfp",
    "istj", "isfj", "estj", "esfj",
    "istp", "isfp", "estp", "esfp",
]


# ---------------------------------------------------------------------------
# 基础绘制工具
# ---------------------------------------------------------------------------

def P(draw, points, color):
    """批量画点：points 为 [(x, y), ...]，color 为 (R,G,B)。"""
    for x, y in points:
        draw.point((x, y), fill=color)


def R(draw, x0, y0, x1, y1, color):
    """填充闭区间矩形（PIL rectangle 本身就是闭区间，这里只做语义封装）。"""
    draw.rectangle([x0, y0, x1, y1], fill=color)


def dilated_outline(mask):
    """由剪影生成 1px 外描边掩码：8 邻域膨胀一圈后减去原剪影。

    描边完全落在剪影之外，因此 sprite 总包围盒 = 剪影包围盒四边各 +1px；
    设计时剪影严格限制在 y3..28，描边恰好落在 y2..29（内容区 28px 高）。
    """
    m = mask.convert("L").point(lambda v: 255 if v else 0)
    dil = m.filter(ImageFilter.MaxFilter(3))  # 3×3 取最大 = 8 邻域膨胀 1px
    a, b = dil.load(), m.load()
    out = Image.new("1", mask.size, 0)
    o = out.load()
    for y in range(mask.size[1]):
        for x in range(mask.size[0]):
            if a[x, y] and not b[x, y]:
                o[x, y] = 1
    return out


# ---------------------------------------------------------------------------
# 共用人类身体骨架（16 只完全一致；frame=1 时躯干/手臂下移 1px 作呼吸）
# ---------------------------------------------------------------------------

def body_geometry(frame):
    """返回 (躯干, 左臂, 右臂, 左腿, 右腿) 五个闭区间矩形。

    frame 0：躯干 y14..22，手臂 y15..21，腿 y23..28
    frame 1：躯干 y14..23（加长 1px），手臂 y16..22，腿 y24..28（压短 1px）
    两帧的头顶、脚底位置完全一致 → 包围盒不变 → pixelate 恒等。
    """
    dy = frame  # 0 或 1：呼吸下移量
    torso = (11, 14, 20, 22 + dy)
    arm_l = (9, 15 + dy, 10, 21 + dy)
    arm_r = (21, 15 + dy, 22, 21 + dy)
    leg_l = (12, 23 + dy, 14, 28)
    leg_r = (17, 23 + dy, 19, 28)
    return torso, arm_l, arm_r, leg_l, leg_r


# 衣服细节款式：人格 → 细节类型（在主色躯干上叠加小面积族内点缀色）
CLOTHES_DETAIL = {
    "intj": "seam",     # 衣襟竖线
    "entj": "shirt",    # 衬衫 V 领三角
    "istj": "pocket",   # 工装口袋
    "estj": "tie",      # 领带
    "estp": "stripes",  # 运动服横条纹
    "esfp": "ruffle",   # 荷叶边领口
    "infp": "hem",      # 裙摆收边
    "enfj": "open",     # 开襟外套两条门襟
}


def paint_body(d, fam_hex, main_idx, frame, personality):
    """画身体骨架的填充色：躯干=人格主色，裤子深一档，鞋=族内最深，手=浅一档点缀。

    光源左上：躯干右侧 1px 用裤子色压暗作体侧阴影。
    """
    fam = [hex2rgb(h) for h in fam_hex]
    main = fam[main_idx]
    pants = fam[max(0, main_idx - 1)]
    accent = fam[min(3, main_idx + 1)]
    shoes = fam[0]

    torso, arm_l, arm_r, leg_l, leg_r = body_geometry(frame)

    # 躯干（人格主色）+ 右侧 1px 体侧阴影
    R(d, *torso, main)
    d.line([(torso[2], torso[1]), (torso[2], torso[3])], fill=pants)

    # 手臂（主色），最底行 1px 手（浅一档，像露出的小手）
    for arm in (arm_l, arm_r):
        R(d, *arm, main)
        d.line([(arm[0], arm[3]), (arm[2], arm[3])], fill=accent)

    # 腿：裤子色；最底 2px 鞋子（族内最深色）
    for leg in (leg_l, leg_r):
        R(d, *leg, pants)
        R(d, leg[0], leg[3] - 1, leg[2], leg[3], shoes)

    # 默认领口线（浅一档）
    d.line([(14, 15), (17, 15)], fill=accent)

    # 人格专属衣服细节
    detail = CLOTHES_DETAIL.get(personality)
    if detail == "seam":
        d.line([(15, 16), (15, torso[3])], fill=accent)          # 衣襟竖线
    elif detail == "shirt":
        P(d, [(14, 15), (15, 15), (16, 15), (15, 16), (16, 16)], fam[3])  # V 领三角
    elif detail == "pocket":
        R(d, 13, 18, 14, 19, accent)                              # 左胸口袋
    elif detail == "tie":
        R(d, 15, 15, 16, 16, fam[0])                              # 领带结
        R(d, 15, 17, 16, 19, fam[0])                              # 领带身
    elif detail == "stripes":
        d.line([(11, 18), (20, 18)], fill=fam[max(0, main_idx - 1)])  # 横条纹
    elif detail == "ruffle":
        P(d, [(13, 15), (15, 15), (17, 15)], fam[min(3, main_idx + 1)])  # 荷叶边
    elif detail == "hem":
        d.line([(11, torso[3]), (20, torso[3])], fill=accent)     # 裙摆收边
    elif detail == "open":
        d.line([(12, 15), (12, torso[3])], fill=accent)           # 左门襟
        d.line([(19, 15), (19, torso[3])], fill=accent)           # 右门襟


# ---------------------------------------------------------------------------
# 16 个动物头：每个函数负责 (1) 向剪影掩码加头部形状 (2) 给头部上色
# 约定：所有剪影 y 范围 3..28（描边占 y2..29），左右关于 x=15.5 对称
# ---------------------------------------------------------------------------

def head_owl(md, d):
    """INTJ 猫头鹰：大圆眼盘 + 头顶两撮耳羽。棕黄头 + 米白眼盘。"""
    base, dark, light, beak = hex2rgb("#A8763E"), hex2rgb("#6B4A1F"), hex2rgb("#F0CE9B"), hex2rgb("#D4A55F")
    md.ellipse([9, 4, 22, 13], fill=1)                       # 头剪影
    P(md, [(10, 3), (11, 3), (20, 3), (21, 3)], 1)           # 耳羽簇
    d.ellipse([9, 4, 22, 13], fill=base)
    P(d, [(10, 3), (11, 3), (20, 3), (21, 3)], dark)         # 耳羽深色
    d.ellipse([10, 5, 14, 9], fill=light)                    # 左大眼盘（5×5 护目镜感）
    d.ellipse([17, 5, 21, 9], fill=light)                    # 右大眼盘
    R(d, 12, 7, 13, 8, OUTLINE)                              # 左瞳孔
    R(d, 18, 7, 19, 8, OUTLINE)                              # 右瞳孔
    P(d, [(15, 10), (16, 10), (15, 11), (16, 11)], beak)     # 喙
    P(d, [(22, 11), (22, 12), (21, 12)], dark)               # 右下阴影
    P(d, [(10, 5), (11, 5)], light)                          # 左上高光


def head_cat(md, d):
    """INTP 猫：三角耳 + 半眯横线眼 + 胡须。橘猫。"""
    base, dark, light = hex2rgb("#D4A55F"), hex2rgb("#A8763E"), hex2rgb("#F0CE9B")
    md.ellipse([9, 5, 22, 13], fill=1)
    P(md, [(11, 3), (10, 4), (11, 4), (12, 4)], 1)           # 左三角耳
    P(md, [(20, 3), (19, 4), (20, 4), (21, 4)], 1)           # 右三角耳
    d.ellipse([9, 5, 22, 13], fill=base)
    P(d, [(11, 3), (20, 3)], dark)                           # 耳尖深色
    P(d, [(11, 4), (20, 4)], light)                          # 内耳
    P(d, [(10, 4), (12, 4), (19, 4), (21, 4)], base)         # 耳廓与头同色
    P(d, [(12, 8), (13, 8), (18, 8), (19, 8)], OUTLINE)      # 半眯横线眼
    R(d, 14, 10, 17, 12, light)                              # 口鼻区
    P(d, [(15, 10), (16, 10)], OUTLINE)                      # 鼻点
    P(d, [(10, 10), (11, 10), (20, 10), (21, 10)], OUTLINE)  # 短胡须
    P(d, [(22, 11), (22, 12)], dark)                         # 右下阴影


def head_lion(md, d):
    """ENTJ 狮子：18px 宽深棕鬃毛环挤着中央圆脸，16 只里最宽的头。"""
    mane, mane_dk, face, light = hex2rgb("#A8763E"), hex2rgb("#6B4A1F"), hex2rgb("#D4A55F"), hex2rgb("#F0CE9B")
    md.ellipse([7, 3, 24, 14], fill=1)                       # 鬃毛大圆
    d.ellipse([7, 3, 24, 14], fill=mane)
    P(d, [(8, 5), (23, 5), (7, 8), (24, 8), (8, 12), (23, 12), (10, 13), (21, 13)], mane_dk)  # 鬃毛锯齿
    d.ellipse([11, 5, 20, 13], fill=face)                    # 脸盘
    R(d, 10, 4, 11, 5, face)                                 # 左耳
    R(d, 20, 4, 21, 5, face)                                 # 右耳
    P(d, [(10, 4), (21, 4)], light)                          # 内耳
    R(d, 12, 7, 13, 8, OUTLINE)                              # 左方眼
    R(d, 18, 7, 19, 8, OUTLINE)                              # 右方眼
    R(d, 14, 9, 17, 11, light)                               # 口鼻
    P(d, [(15, 9), (16, 9)], OUTLINE)                        # 鼻点


def head_fox(md, d):
    """ENTP 狐狸：高尖耳 + 前突尖吻 + 吊梢眼。"""
    base, tip, light = hex2rgb("#D4A55F"), hex2rgb("#6B4A1F"), hex2rgb("#F0CE9B")
    md.ellipse([10, 5, 21, 13], fill=1)
    P(md, [(10, 3), (11, 3), (10, 4), (11, 4), (12, 4), (10, 5), (11, 5)], 1)   # 左高耳
    P(md, [(20, 3), (21, 3), (20, 4), (21, 4), (19, 4), (20, 5), (21, 5)], 1)   # 右高耳
    R(md, 14, 11, 17, 13, 1)                                 # 吻部前突
    P(md, [(15, 14), (16, 14)], 1)                           # 吻尖
    d.ellipse([10, 5, 21, 13], fill=base)
    P(d, [(10, 3), (11, 3), (20, 3), (21, 3)], tip)          # 耳尖深色
    P(d, [(10, 4), (11, 4), (12, 4), (10, 5), (11, 5)], base)
    P(d, [(19, 4), (20, 4), (21, 4), (20, 5), (21, 5)], base)
    P(d, [(12, 7), (13, 7), (18, 7), (19, 7)], OUTLINE)      # 吊梢眼
    R(d, 14, 11, 17, 13, light)                              # 浅色吻面
    P(d, [(15, 14), (16, 14)], OUTLINE)                      # 鼻尖


def head_swan(md, d):
    """INFJ 天鹅：唯一的长颈结构 + 闭眼竖线目。米白拟白。"""
    body_c, beak = hex2rgb("#F0CE9B"), hex2rgb("#D4A55F")
    md.ellipse([13, 3, 18, 7], fill=1)                       # 小圆头
    P(md, [(14, 8), (15, 8), (13, 9), (14, 9), (13, 10), (14, 10),
           (13, 11), (14, 11), (13, 12), (14, 12), (14, 13), (15, 13)], 1)  # 左弯长颈
    d.ellipse([13, 3, 18, 7], fill=body_c)
    P(d, [(14, 8), (15, 8), (13, 9), (14, 9), (13, 10), (14, 10),
          (13, 11), (14, 11), (13, 12), (14, 12), (14, 13), (15, 13)], body_c)
    P(d, [(15, 5), (16, 5)], beak)                           # 喙
    P(d, [(15, 4), (16, 4)], OUTLINE)                        # 喙基黑线
    P(d, [(14, 4), (17, 4)], OUTLINE)                        # 闭眼竖线目（垂目）
    P(d, [(14, 5), (17, 5)], OUTLINE)


def head_butterfly(md, d):
    """INFP 蝴蝶：球状端触角 + 大复眼 + 背部一对浅绿翅膀。"""
    head_c, eye, wing, wing_dk, club = (hex2rgb("#6FAF88"), hex2rgb("#1F4433"),
                                        hex2rgb("#A8D5BA"), hex2rgb("#3E7C59"), hex2rgb("#3E7C59"))
    md.ellipse([11, 5, 20, 13], fill=1)                      # 头
    P(md, [(13, 4), (18, 4)], 1)                             # 触角柄
    R(md, 11, 3, 12, 4, 1)                                   # 左触角球
    R(md, 19, 3, 20, 4, 1)                                   # 右触角球
    # 背翅剪影（与肩臂相连）
    P(md, [(7, 14), (8, 14), (6, 15), (7, 15), (8, 15), (6, 16), (7, 16), (8, 16), (7, 17)], 1)
    P(md, [(23, 14), (24, 14), (23, 15), (24, 15), (25, 15), (23, 16), (24, 16), (25, 16), (24, 17)], 1)
    d.ellipse([11, 5, 20, 13], fill=head_c)
    P(d, [(13, 4), (18, 4)], OUTLINE)                        # 触角柄
    R(d, 11, 3, 12, 4, club)                                 # 左触角球
    R(d, 19, 3, 20, 4, club)                                 # 右触角球
    R(d, 12, 7, 13, 9, eye)                                  # 左大复眼
    R(d, 18, 7, 19, 9, eye)                                  # 右大复眼
    # 背翅上色（浅绿底 + 深绿斑）
    P(d, [(7, 14), (8, 14), (6, 15), (7, 15), (8, 15), (6, 16), (7, 16), (8, 16), (7, 17)], wing)
    P(d, [(23, 14), (24, 14), (23, 15), (24, 15), (25, 15), (23, 16), (24, 16), (25, 16), (24, 17)], wing)
    P(d, [(7, 15), (24, 15)], wing_dk)                       # 翅斑


def head_golden(md, d):
    """ENFJ 金毛：贴脸垂耳 + 前突口鼻 + 带高光的暖圆眼。"""
    base, ear, light = hex2rgb("#D4A55F"), hex2rgb("#A8763E"), hex2rgb("#F0CE9B")
    md.ellipse([9, 3, 22, 12], fill=1)
    R(md, 7, 4, 8, 8, 1)                                     # 左垂耳
    R(md, 23, 4, 24, 8, 1)                                   # 右垂耳
    d.ellipse([9, 3, 22, 12], fill=base)
    R(d, 7, 4, 8, 8, ear)
    R(d, 23, 4, 24, 8, ear)
    R(d, 11, 6, 12, 7, OUTLINE)                              # 左眼
    R(d, 19, 6, 20, 7, OUTLINE)                              # 右眼
    P(d, [(11, 6), (19, 6)], light)                          # 眼高光
    R(d, 13, 8, 18, 11, light)                               # 口鼻
    R(d, 15, 8, 16, 9, OUTLINE)                              # 鼻
    P(d, [(15, 11), (16, 11)], OUTLINE)                      # 微笑


def head_dolphin(md, d):
    """ENFP 海豚：大额隆 + 扁吻突 + 头顶呼吸孔 + 永远微笑的嘴角。"""
    base, light = hex2rgb("#5B8FC7"), hex2rgb("#9DC3E6")
    md.ellipse([9, 3, 22, 12], fill=1)                       # 大额隆圆头
    R(md, 12, 12, 19, 13, 1)                                 # 吻突（加宽）
    d.ellipse([9, 3, 22, 12], fill=base)
    P(d, [(15, 3), (16, 3)], OUTLINE)                        # 呼吸孔
    R(d, 11, 6, 12, 7, OUTLINE)                              # 左眼
    R(d, 19, 6, 20, 7, OUTLINE)                              # 右眼
    R(d, 12, 12, 19, 13, light)                              # 宽吻突浅色（吻部是海豚辨识度核心）
    P(d, [(13, 12), (14, 12), (15, 12), (16, 12), (17, 12), (18, 12)], OUTLINE)  # 微笑弧线
    P(d, [(21, 10), (21, 11), (22, 10)], hex2rgb("#33608F"))  # 右下阴影


def head_beaver(md, d):
    """ISTJ 海狸：两颗并排大门牙是灵魂 + 小圆耳 + 平眉认真脸。"""
    base, ear, muzzle, teeth = hex2rgb("#A8763E"), hex2rgb("#6B4A1F"), hex2rgb("#D4A55F"), hex2rgb("#F0CE9B")
    md.ellipse([9, 4, 22, 13], fill=1)
    R(md, 10, 3, 11, 4, 1)                                   # 左小圆耳
    R(md, 20, 3, 21, 4, 1)                                   # 右小圆耳
    d.ellipse([9, 4, 22, 13], fill=base)
    R(d, 10, 3, 11, 4, ear)
    R(d, 20, 3, 21, 4, ear)
    R(d, 11, 7, 12, 8, OUTLINE)                              # 左方眼
    R(d, 19, 7, 20, 8, OUTLINE)                              # 右方眼
    P(d, [(11, 6), (12, 6), (19, 6), (20, 6)], OUTLINE)      # 平眉
    R(d, 13, 9, 18, 12, muzzle)                              # 口鼻区
    P(d, [(15, 9), (16, 9)], OUTLINE)                        # 鼻点
    # 大门牙：上排 4px 整排，下排只留两端——中间缺口把"两颗板牙"读出来
    P(d, [(14, 12), (15, 12), (16, 12), (17, 12)], teeth)
    P(d, [(14, 13), (17, 13)], teeth)


def head_penguin(md, d):
    """ISFJ 企鹅：深蓝圆头 + 大白脸盘 + 橘三角喙，无耳。"""
    base, face, beak = hex2rgb("#1F3A5F"), hex2rgb("#9DC3E6"), hex2rgb("#D4A55F")
    md.ellipse([9, 3, 22, 13], fill=1)
    d.ellipse([9, 3, 22, 13], fill=base)
    d.ellipse([11, 5, 20, 13], fill=face)                    # 白脸盘
    P(d, [(12, 6), (13, 6), (18, 6), (19, 6)], OUTLINE)      # 圆眼
    P(d, [(15, 9), (16, 9), (15, 10), (16, 10)], beak)       # 喙


def head_bear(md, d):
    """ESTJ 熊：16px 宽方下巴头 + 半圆耳 + 下压眉线。深棕。"""
    base, muzzle = hex2rgb("#6B4A1F"), hex2rgb("#A8763E")
    md.ellipse([8, 4, 23, 13], fill=1)
    R(md, 9, 3, 10, 4, 1)                                    # 左圆耳
    R(md, 21, 3, 22, 4, 1)                                   # 右圆耳
    d.ellipse([8, 4, 23, 13], fill=base)
    R(d, 9, 3, 10, 4, base)
    R(d, 21, 3, 22, 4, base)
    P(d, [(10, 4), (21, 4)], muzzle)                         # 内耳
    R(d, 11, 7, 12, 8, OUTLINE)                              # 左方眼
    R(d, 19, 7, 20, 8, OUTLINE)                              # 右方眼
    P(d, [(11, 6), (12, 6), (19, 6), (20, 6)], OUTLINE)      # 下压眉线
    R(d, 13, 9, 18, 13, muzzle)                              # 口鼻
    R(d, 15, 9, 16, 10, OUTLINE)                             # 鼻


def head_elephant(md, d):
    """ESFJ 大象：3px 宽垂鼻搭到领口 + 两侧扇形大耳 + 小象牙。"""
    base, ear_in, tusk = hex2rgb("#5B8FC7"), hex2rgb("#9DC3E6"), hex2rgb("#F0CE9B")
    md.ellipse([10, 3, 21, 10], fill=1)                      # 头
    P(md, [(7, 4), (8, 4), (9, 4), (6, 5), (7, 5), (8, 5), (9, 5),
           (6, 6), (7, 6), (8, 6), (9, 6), (6, 7), (7, 7), (8, 7), (9, 7),
           (7, 8), (8, 8), (9, 8)], 1)                       # 左大耳
    P(md, [(22, 4), (23, 4), (24, 4), (22, 5), (23, 5), (24, 5), (25, 5),
           (22, 6), (23, 6), (24, 6), (25, 6), (22, 7), (23, 7), (24, 7), (25, 7),
           (22, 8), (23, 8), (24, 8)], 1)                    # 右大耳
    R(md, 15, 7, 16, 14, 1)                                  # 垂鼻（搭到领口）
    d.ellipse([10, 3, 21, 10], fill=base)
    # 大耳：外缘主体色、内耳浅蓝
    P(d, [(7, 4), (8, 4), (9, 4), (6, 5), (7, 5), (8, 5), (9, 5),
          (6, 6), (7, 6), (8, 6), (9, 6), (6, 7), (7, 7), (8, 7), (9, 7),
          (7, 8), (8, 8), (9, 8)], base)
    P(d, [(22, 4), (23, 4), (24, 4), (22, 5), (23, 5), (24, 5), (25, 5),
          (22, 6), (23, 6), (24, 6), (25, 6), (22, 7), (23, 7), (24, 7), (25, 7),
          (22, 8), (23, 8), (24, 8)], base)
    P(d, [(7, 5), (8, 5), (7, 6), (8, 6), (7, 7), (8, 7),
          (23, 5), (24, 5), (23, 6), (24, 6), (23, 7), (24, 7)], ear_in)  # 内耳
    R(d, 15, 7, 16, 14, base)                                # 垂鼻
    P(d, [(15, 14), (16, 14)], OUTLINE)                      # 鼻孔
    P(d, [(13, 10), (13, 11), (18, 10), (18, 11)], tusk)     # 小象牙
    R(d, 11, 5, 12, 6, OUTLINE)                              # 左垂眼
    R(d, 19, 5, 20, 6, OUTLINE)                              # 右垂眼


def head_leopard(md, d):
    """ISTP 豹：猫科基础脸 + 深棕斑纹 + 细长锐眼。"""
    base, spot, light = hex2rgb("#D4A55F"), hex2rgb("#6B4A1F"), hex2rgb("#F0CE9B")
    md.ellipse([9, 5, 22, 13], fill=1)
    P(md, [(11, 3), (10, 4), (11, 4), (12, 4)], 1)           # 左耳
    P(md, [(20, 3), (19, 4), (20, 4), (21, 4)], 1)           # 右耳
    d.ellipse([9, 5, 22, 13], fill=base)
    P(d, [(11, 3), (20, 3)], spot)                           # 耳尖
    P(d, [(11, 4), (20, 4)], light)                          # 内耳
    P(d, [(10, 4), (12, 4), (19, 4), (21, 4)], base)
    # 豹斑：2×2 块状斑才在 128px 显示尺寸下可读（1px 斑点会消失）
    P(d, [(10, 6), (11, 6), (10, 7), (11, 7)], spot)         # 左颞斑
    P(d, [(20, 6), (21, 6), (20, 7), (21, 7)], spot)         # 右颞斑
    P(d, [(15, 5), (16, 5)], spot)                           # 额斑
    P(d, [(12, 8), (13, 8), (18, 8), (19, 8)], OUTLINE)      # 细长锐眼
    R(d, 14, 10, 17, 12, light)                              # 口鼻
    P(d, [(15, 10), (16, 10)], OUTLINE)                      # 鼻点


def head_capybara(md, d):
    """ISFP 卡皮巴拉：方块钝吻 + 高位半闭眼 + 头顶小橘子（名梗）。"""
    base, muzzle, orange, leaf = hex2rgb("#A8763E"), hex2rgb("#D4A55F"), hex2rgb("#D4A55F"), hex2rgb("#3E7C59")
    md.ellipse([9, 5, 22, 13], fill=1)
    R(md, 11, 3, 12, 4, 1)                                   # 左小耳
    R(md, 19, 3, 20, 4, 1)                                   # 右小耳
    R(md, 15, 3, 16, 4, 1)                                   # 头顶橘子
    R(md, 12, 9, 19, 13, 1)                                  # 方块钝吻
    d.ellipse([9, 5, 22, 13], fill=base)
    R(d, 11, 3, 12, 4, base)
    R(d, 19, 3, 20, 4, base)
    R(d, 15, 3, 16, 4, orange)                               # 橘子
    P(d, [(16, 3)], leaf)                                    # 橘子叶
    P(d, [(12, 6), (13, 6), (18, 6), (19, 6)], OUTLINE)      # 高位半闭眼
    R(d, 12, 9, 19, 13, muzzle)                              # 钝吻
    P(d, [(14, 10), (17, 10)], OUTLINE)                      # 鼻孔


def head_monkey(md, d):
    """ESTP 猴子：浅色心形脸盘 + 脸侧外凸大圆耳 + 咧嘴笑。"""
    base, face = hex2rgb("#A8763E"), hex2rgb("#F0CE9B")
    md.ellipse([9, 3, 22, 12], fill=1)
    R(md, 7, 5, 8, 7, 1)                                     # 左大圆耳
    R(md, 23, 5, 24, 7, 1)                                   # 右大圆耳
    d.ellipse([9, 3, 22, 12], fill=base)
    R(d, 7, 5, 8, 7, base)
    R(d, 23, 5, 24, 7, base)
    P(d, [(8, 6), (23, 6)], face)                            # 内耳
    d.ellipse([11, 5, 20, 12], fill=face)                    # 浅脸盘
    R(d, 12, 7, 13, 8, OUTLINE)                              # 左眼
    R(d, 18, 7, 19, 8, OUTLINE)                              # 右眼
    P(d, [(14, 10), (15, 10), (16, 10), (17, 10)], OUTLINE)  # 咧嘴笑


def head_parrot(md, d):
    """ESFP 鹦鹉：下弯钩喙 + 头顶三根冠羽 + 浅绿眼圈。绿羽。"""
    base, crest, beak, ring = hex2rgb("#3E7C59"), hex2rgb("#6FAF88"), hex2rgb("#D4A55F"), hex2rgb("#A8D5BA")
    md.ellipse([10, 4, 21, 13], fill=1)
    P(md, [(13, 3), (15, 3), (17, 3)], 1)                    # 三根冠羽
    d.ellipse([10, 4, 21, 13], fill=base)
    P(d, [(13, 3), (15, 3), (17, 3)], crest)                 # 冠羽
    P(d, [(12, 6), (13, 6), (18, 6), (19, 6)], ring)         # 眼圈上沿
    P(d, [(12, 7), (13, 7), (18, 7), (19, 7)], OUTLINE)      # 圆眼
    # 钩喙放大：上沿 4px、向右下逐行收窄，喙尖下勾——钩形轮廓是鹦鹉的关键
    P(d, [(14, 9), (15, 9), (16, 9), (17, 9)], beak)
    P(d, [(15, 10), (16, 10), (17, 10)], beak)
    P(d, [(16, 11), (17, 11)], beak)
    P(d, [(17, 12)], OUTLINE)                                # 喙尖下勾
    P(d, [(11, 9), (11, 10), (20, 9), (20, 10)], ring)       # 脸颊浅斑


# 人格 → 头部绘制函数
HEADS = {
    "intj": head_owl, "intp": head_cat, "entj": head_lion, "entp": head_fox,
    "infj": head_swan, "infp": head_butterfly, "enfj": head_golden, "enfp": head_dolphin,
    "istj": head_beaver, "isfj": head_penguin, "estj": head_bear, "esfj": head_elephant,
    "istp": head_leopard, "isfp": head_capybara, "estp": head_monkey, "esfp": head_parrot,
}


# ---------------------------------------------------------------------------
# 组装与校验
# ---------------------------------------------------------------------------

def build_sprite(personality, frame):
    """组装一只 sprite：剪影 → 身体上色 → 动物头上色 → 描边。

    返回 RGBA Image（32×32，alpha 只有 0/255，颜色全部在限定色板内）。
    """
    fam_name, main_idx = PERSONALITY_FAMILY[personality]
    fam_hex = FAMILIES[fam_name]

    # 第 1 步：剪影掩码（身体骨架 + 动物头外形）
    mask = Image.new("1", (CANVAS, CANVAS), 0)
    md = ImageDraw.Draw(mask)
    for rect in body_geometry(frame):
        md.rectangle(list(rect), fill=1)
    # 动物头剪影：每个 HEADS 函数前两行负责向 md 加形状（见各函数注释）
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 先给身体上色（头部函数里部分形状会压住躯干顶行，如象鼻/狐吻，须后画）
    paint_body(d, fam_hex, main_idx, frame, personality)
    HEADS[personality](md, d)

    # 第 2 步：描边（剪影膨胀一圈 - 剪影），最后画，压住一切外缘
    outline_mask = dilated_outline(mask)
    o = outline_mask.load()
    px = img.load()
    for y in range(CANVAS):
        for x in range(CANVAS):
            if o[x, y]:
                px[x, y] = (*OUTLINE, 255)

    # 第 3 步：硬规范自检（包围盒 + 帧差异在外层统一验）
    bbox = img.getbbox()
    assert bbox is not None, f"{personality} 帧{frame} 没有内容"
    assert bbox[1] == 2 and bbox[3] == 30, (
        f"{personality} 帧{frame} 纵向包围盒应为 y2..29，实际 {bbox}（剪影越界）")
    assert (bbox[2] - bbox[0]) <= 28, f"{personality} 帧{frame} 内容过宽：{bbox}"
    # 左右对称居中：pixelate 居中贴入时偏移必须与原位置一致（恒等变换前提）
    w = bbox[2] - bbox[0]
    assert bbox[0] == (CANVAS - w) // 2, f"{personality} 帧{frame} 内容未居中：{bbox}"
    return img


def allowed_colors():
    """限定色板全集：16 族色 + outline（与 pixelate.load_palette 同口径）。"""
    colors = {OUTLINE}
    for fam in FAMILIES.values():
        colors.update(hex2rgb(h) for h in fam)
    return colors


def validate_sprite(img, personality, frame):
    """逐像素校验：alpha ∈ {0,255}；不透明像素颜色全部在限定色板内。"""
    allowed = allowed_colors()
    data = img.convert("RGBA").tobytes()
    for i in range(0, len(data), 4):
        r, g, b, a = data[i], data[i + 1], data[i + 2], data[i + 3]
        assert a in (0, 255), f"{personality} 帧{frame} 有半透明像素 alpha={a}"
        if a == 255:
            assert (r, g, b) in allowed, (
                f"{personality} 帧{frame} 颜色 {(r, g, b)} 不在限定色板内")


def make_sheet():
    """拼 16 宫格目检图：每格为 idle_0 放大 4 倍（128px），4×4 排列，透明底。

    输出 assets/art/sprite-sheet.png（512×512），供 owner 目检风格统一性。
    """
    tile = 128
    sheet = Image.new("RGBA", (tile * 4, tile * 4), (0, 0, 0, 0))
    for idx, p in enumerate(SHEET_ORDER):
        src = SPRITES_DIR / p / "idle_0.png"
        img = Image.open(src).convert("RGBA").resize((tile, tile), Image.NEAREST)
        gx, gy = (idx % 4) * tile, (idx // 4) * tile
        sheet.paste(img, (gx, gy), img)  # mask=img 保证 alpha 原样拷贝（仍是 1-bit）
    SHEET_PATH.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEET_PATH, "PNG")
    print(f"已输出 16 宫格目检图：{SHEET_PATH}")


def main(argv=None):
    """生成入口：16 只 × idle 2 帧，逐只自检后落盘；--sheet 时额外拼宫格图。"""
    parser = argparse.ArgumentParser(description="程序化绘制 16 人格兽首人身 sprite（32×32 / idle 2 帧）")
    parser.add_argument("--sheet", action="store_true", help="额外拼 16 宫格目检图 assets/art/sprite-sheet.png")
    args = parser.parse_args(argv)

    for p in SHEET_ORDER:
        out_dir = SPRITES_DIR / p
        out_dir.mkdir(parents=True, exist_ok=True)
        frames = []
        for frame in (0, 1):
            img = build_sprite(p, frame)
            validate_sprite(img, p, frame)
            frames.append(img)
            img.save(out_dir / f"idle_{frame}.png", "PNG")
        # 两帧必须真的有差异（呼吸帧不是复制粘贴）
        assert frames[0].tobytes() != frames[1].tobytes(), f"{p} 的 idle 两帧完全相同"
        print(f"[OK] {p}：idle_0.png / idle_1.png 已生成并通过板内色自检")

    if args.sheet:
        make_sheet()
    return 0


if __name__ == "__main__":
    sys.exit(main())
