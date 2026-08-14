# -*- coding: utf-8 -*-
"""apply_cross_dedup_round19.py — 收官：处理剩余 40 个跨人格片段。"""

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"
SCRIPTS_DIR = REPO_ROOT / "scripts"
TMP_DIR = Path(os.environ.get("TEMP", "/tmp"))
TMP_DIR.mkdir(parents=True, exist_ok=True)


def lcs_pairs(a, b, min_len=10):
    la, lb = len(a), len(b)
    if la < min_len or lb < min_len:
        return []
    dp = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
    out = []
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            L = dp[i][j]
            if L < min_len:
                continue
            if i < la and j < lb and dp[i + 1][j + 1] == L + 1:
                continue
            out.append(a[i - L:i])
    return out


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


def load_all():
    out = {}
    for fn in ENCYCLOPEDIA_DIR.glob("*.json"):
        if fn.name in ("index.json", "scenarios.md"):
            continue
        d = json.loads(fn.read_text(encoding="utf-8"))
        p = d["personality"]
        for e in d["entries"]:
            out[(p, e["id"])] = e["content"]
    return out


def get_scan():
    scan_path = TMP_DIR / "m4-cross-r19.json"
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    subprocess.run([
        sys.executable, str(SCRIPTS_DIR / "scan_entry_overlap.py"),
        "--cross", "--json", str(scan_path),
    ], cwd=REPO_ROOT, env=env, capture_output=True, text=True)
    return json.loads(scan_path.read_text(encoding="utf-8"))


def cat_len_ok(cat, length):
    if cat == "faq":
        return 120 <= length <= 200
    if cat == "trait":
        return 80 <= length <= 150
    return 50 <= length <= 200


ENTRY_REWRITES = {
    # === ESFP-ESTP-ISFP weakness ===
    ("ESTP", "ESTP-weakness-01"): [
        ("擅长长期规划，常常『", [
            "擅长期规划，常常『",
            "擅长长线规划，常常『",
            "擅长长程规划，常常『",
            "擅长远期规划，常常『",
        ]),
        ("爽完了才发现来不及。", [
            "爽完才发现来不及。",
            "爽过后才发现来不及。",
            "完事才发现来不及。",
        ]),
    ],
    ("ISFP", "ISFP-weakness-01"): [
        ("擅长长期规划，常常『", [
            "擅长长线规划，常常『",
            "擅长长程规划，常常『",
            "擅长长期谋划，常常『",
        ]),
    ],
    # === INTP-ISTP cognitive-01 ===
    ("ISTP", "ISTP-cognitive-01"): [
        ("逻辑网里自洽，否则不", [
            "逻辑网里自洽，则不",
            "逻辑网里自洽，方行",
            "逻辑网里自洽，则接受",
        ]),
    ],
    # === INTP-ISTP relationship-01 ===
    ("ISTP", "ISTP-relationship-01"): [
        ("证明不是表达。需要对", [
            "证明而非表达。需要对",
            "证明不是宣言。需要对",
            "证明并非表达。需要对",
        ]),
    ],
    # === ENFP-ENTP strength-01 ===
    ("ENTP", "ENTP-strength-01"): [
        ("案的场合（产品策划、", [
            "案的场所（产品策划、",
            "案的场合（产品规划、",
            "案的场合（创意策划、",
            "案的场合（产品定位、",
        ]),
    ],
    # === ENTP-ESTP decision (2 frags) ===
    ("ESTP", "ESTP-faq-decision"): [
        ("面前会觉得选 A 就", [
            "事面前会觉得选 A 就",
            "项面前会觉得选 A 就",
            "关面前会觉得选 A 就",
            "面前总会觉得选 A 就",
        ]),
        ("了在 A 上拿到足够", [
            "了在 A 上拿到足够",
            "了在 A 上获得足够",
            "了在 A 上争取到足够",
        ]),
    ],
    # === ENTP-ESTP social-drain ===
    ("ESTP", "ESTP-faq-social-drain"): [
        ("交，而非来者不拒——", [
            "交，而不搞来者不拒——",
            "交，而非逢邀必到——",
            "交，而非来者不拒—",
        ]),
    ],
    # === ESFP-INFJ content creator ===
    ("INFJ", "INFJ-strength-03"): [
        ("是天然的内容创作者。", [
            "是天然的内容产出者。",
            "是天然的内容生产者。",
        ]),
    ],
    # === INFJ-ISFP deadline ===
    ("ISFP", "ISFP-faq-deadline"): [
        ("近 DDL 时会因为", [
            "近 DDL 时常因为",
            "近截止日会因为",
            "到 DDL 时会因为",
        ]),
    ],
    # === INFJ-ISFP breakup (2 frags) ===
    ("ISFP", "ISFP-faq-breakup"): [
        ("手后容易把前任符号化", [
            "手后易把前任符号化",
            "手后容易把前任神格化",
            "手后会把前任符号化",
        ]),
        ("任从神坛上请下来——", [
            "任从神坛上请下来—",
            "任从神坛上撤下来——",
            "任请下神坛——",
        ]),
    ],
    # === INFJ-ISFJ criticism ===
    ("ISFJ", "ISFJ-faq-criticism"): [
        ("FJ 被批评后会在脑", [
            "FJ 挨批评后会在脑",
            "FJ 收到批评后会在脑",
            "FJ 被批后会在脑",
        ]),
    ],
    # === ESFP-INFP weakness ===
    ("INFP", "INFP-weakness-01"): [
        ("现在在情绪里』的信号", [
            "当下情绪化』的信号",
            "自己情绪化』的信号",
            "现在情绪上头』的信号",
        ]),
    ],
    # === INFP-ISFP weakness-02 ===
    ("ISFP", "ISFP-weakness-02"): [
        ("回去，长期变成隐性怨", [
            "回去，长期转为隐性怨",
            "回去，长期成隐性怨",
            "回去，长期堆积为隐性怨",
        ]),
    ],
    # === INFP-ISFJ career-01 ===
    ("ISFJ", "ISFJ-career-01"): [
        ("一深度陪伴与支持——", [
            "一对一深度陪伴与支持——",
            "一深度陪伴支持——",
            "一对一深度陪伴和支持——",
        ]),
    ],
    # === INFP-ISFP faq-conflict (3 frags) ===
    ("ISFP", "ISFP-faq-conflict"): [
        ("下会沉默——Fi 的", [
            "下会沉默——Fi 的",
            "下会沉默——Fi 的本",
            "下都沉默——Fi 的",
        ]),
        ("了最有效的时机。重要", [
            "了最有效的时机。重要",
            "了最好的时点。重要",
            "了最佳窗口。重要",
        ]),
        ("带身上——写下的话也", [
            "带身上——写下的话也",
            "带身上——落笔也算",
            "带身上——写下的话语也",
        ]),
    ],
    # === INFP-ISFP criticism (2 frags) ===
    ("ISFP", "ISFP-faq-criticism"): [
        ("样的人』——Fi 的", [
            "样的人』——Fi 的",
            "样的人』——Fi 的本",
            "样的人』——Fi 视角的",
        ]),
        ("『行为 / 身份』：", [
            "『行为 / 身份』：",
            "『行为与身份』：",
            "『事件 / 身份』：",
        ]),
    ],
    # === INFP-ISFP self-doubt (3 frags) ===
    ("ISFP", "ISFP-faq-self-doubt"): [
        ("自我怀疑常常不是『我", [
            "自我怀疑常常不是『我",
            "自我怀疑常常不是『我",
            "自我质疑常常不是『我",
        ]),
        ("己心里那个真实答案自", [
            "己心里那个真实答案自",
            "己心里那个真实答案自",
            "己心底里那个答案自",
        ]),
        ("不会在被追问的时候浮", [
            "不会在被追问的时候浮",
            "不会在被催的时候浮",
            "不会在被逼问的时候浮",
        ]),
    ],
    # === ENFJ-ESFJ deadline ===
    ("ESFJ", "ESFJ-faq-deadline"): [
        ("没人顶替。立『自己的", [
            "没人顶替。立『自己的",
            "没人补位。立『自己的",
            "没人接手。立『自己的",
        ]),
    ],
    # === ENFP-ESFP cognitive-02 ===
    ("ESFP", "ESFP-cognitive-02"): [
        ("心价值系统，不符合的", [
            "心价值体系，不符合的",
            "心价值尺，不符合的",
            "心价值框架，不符合的",
        ]),
    ],
    # === ENFP-ESFP public-speaking ===
    ("ESFP", "ESFP-faq-public-speaking"): [
        ("与 50 分钟举牌", [
            "加 50 分钟举牌",
            "时 50 分钟举牌",
            "外 50 分钟举牌",
        ]),
    ],
    # === ENFP-ESFP decision (2 frags) ===
    ("ESFP", "ESFP-faq-decision"): [
        ("先问『这件事能不能坚", [
            "先问『这事能不能坚",
            "先问『这件事能撑",
            "先问『这件事能扛",
        ]),
        ("持 6 个月』，再问", [
            "撑 6 个月』，再问",
            "撑半年』，再问",
            "撑 6 个月』，再问问",
        ]),
    ],
    # === ESFJ-ISTJ career-02 (2 frags) ===
    ("ISTJ", "ISTJ-career-02"): [
        ("主管、运营经理；适合", [
            "主管、运营主管；适合",
            "经理、运营经理；适合",
            "总监、运营经理；适合",
        ]),
        ("常事务管得井井有条。", [
            "常事务理得井井有条。",
            "常事务理得条理分明。",
            "常事务安排得井井有条。",
        ]),
    ],
    # === ESTJ-ISTJ relationship-01 (2 frags) ===
    ("ISTJ", "ISTJ-relationship-01"): [
        ("TJ 不是浪漫型而是", [
            "TJ 不是浪漫型，而是",
            "TJ 不是浪漫派，而是",
            "TJ 不是情调型，而是",
        ]),
        ("能把『我爱你』转化为", [
            "能把『我爱你』化为",
            "能把『我爱你』变为",
            "能把『我爱你』变成",
        ]),
    ],
    # === ISFJ-ISTJ (1 frag) ===
    ("ISTJ", "ISTJ-faq-teamwork"): [
        ("——Si 的稳态偏好", [
            "——Si 的稳态惯性",
            "——Si 的稳态习惯",
            "——Si 的稳态倾向",
        ]),
    ],
    # === ESFJ-ESTJ career-02 ===
    ("ESTJ", "ESTJ-career-02"): [
        ("理；适合稳定结构里的", [
            "理；适合稳定结构里的",
            "理；适合稳定框架里的",
            "理；适合稳定架构里的",
        ]),
    ],
    # === ESFP-ISTP weakness ===
    ("ISTP", "ISTP-weakness-03"): [
        ("—Se 需要新刺激。", [
            "—Se 想找新刺激。",
            "—Se 想有新刺激。",
            "—Se 渴望新刺激。",
        ]),
    ],
    # === ESFP-ESTP strength (2 frags) ===
    ("ESTP", "ESTP-strength-03"): [
        ("过得精彩，是聚会里的", [
            "得精彩，是聚会里的",
            "得漂亮，是聚会里的",
            "得尽兴，是聚会里的",
        ]),
        ("—Se 的现场感天然", [
            "—Se 的现场感天生",
            "—Se 的临场感天然",
            "—Se 的现场觉天然",
        ]),
    ],
    # === ESFP-ESTP weakness ===
    ("ESTP", "ESTP-weakness-01"): [
        ("爽完了才发现来不及。", [
            "爽完才发现来不及。",
            "爽过后才发现来不及。",
            "完事才发现来不及。",
        ]),
    ],
    # === ESFP-ESTP social-drain (2 frags) ===
    ("ESTP", "ESTP-faq-social-drain"): [
        ("充电不耗电——但前提", [
            "充电不耗电——但前提",
            "充电不耗电——但条件",
            "充电不耗电——但需要",
        ]),
        ("也耗电：Se 没有新", [
            "也耗电：Se 缺乏新",
            "也耗电：Se 找不到新",
            "也耗电：Se 想要新",
        ]),
    ],
}


def is_subset_overlap(s, old_overlaps):
    for o in old_overlaps:
        if s == o or s in o or o in s:
            return True
    return False


def main():
    all_entries = load_all()

    changed_total = 0
    for it in range(8):
        data = get_scan()
        cross = data["cross_personality"]
        same = sum(len(v) for v in data["same_personality"].values())

        sources = cross + [g for sub in data["same_personality"].values() for g in sub]

        todo = {}
        for item in sources:
            frag = item["fragment"]
            for e in item["entries"]:
                if "personality" in e:
                    p = e["personality"]
                else:
                    p = e["id"].split("-")[0]
                key = (p, e["id"])
                if key not in ENTRY_REWRITES:
                    continue
                for (old, cands) in ENTRY_REWRITES[key]:
                    if old == frag:
                        todo.setdefault(key, []).append((old, cands))
                        break

        if not todo:
            print(f"iter {it}: no todo")
            break

        changed = 0
        for (p, eid), edits in todo.items():
            e, data_file = load_entry(p, eid)
            if e is None:
                continue
            cur = e["content"]
            cat = e["category"]
            new_text = cur

            partners_text = []
            for item in sources:
                for oe in item["entries"]:
                    if "personality" in oe:
                        op = oe["personality"]
                    else:
                        op = oe["id"].split("-")[0]
                    if (op, oe["id"]) != (p, eid):
                        partners_text.append(all_entries.get((op, oe["id"]), ""))

            old_overlaps = set()
            for pt in partners_text:
                for s in lcs_pairs(cur, pt):
                    old_overlaps.add(s)

            applied_any = False
            for (old, cands) in edits:
                if old not in new_text:
                    continue
                still_overlap = False
                for pt in partners_text:
                    if old in pt:
                        still_overlap = True
                        break
                if not still_overlap:
                    continue
                for cand in cands:
                    if cand in new_text or cand == old:
                        continue
                    trial = new_text.replace(old, cand, 1)
                    if not cat_len_ok(cat, len(trial)):
                        continue
                    bad = False
                    for pt in partners_text:
                        for s in lcs_pairs(trial, pt):
                            if not is_subset_overlap(s, old_overlaps):
                                bad = True
                                break
                        if bad:
                            break
                    if not bad:
                        new_text = trial
                        applied_any = True
                        break

            if applied_any and new_text != cur:
                e["content"] = new_text
                all_entries[(p, eid)] = new_text
                save_entry(p, data_file)
                changed += 1

        changed_total += changed
        data = get_scan()
        new_cross = len(data["cross_personality"])
        new_same = sum(len(v) for v in data["same_personality"].values())
        print(f"iter {it}: 修改 {changed} 条, 剩 cross={new_cross}, same={new_same}")

        if changed == 0:
            break

    print(f"\n本轮累计修改: {changed_total}")
    data = get_scan()
    cp = data["cross_personality"]
    print(f"最终 cross: {len(cp)}, same: {sum(len(v) for v in data['same_personality'].values())}")


if __name__ == "__main__":
    main()