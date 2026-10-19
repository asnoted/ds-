#!/usr/bin/env python3
"""审计 GitHub issue 的状态与标签是否自相矛盾.

**为什么要有它**: 2026-10-11 手工清点时查出三类乱象 -- 已关闭的票还挂着
`needs-triage`(它的含义是"等维护者评估", 票都关了就没这回事了); 一张票同时挂
`wontfix` 与 `ready-for-agent`(标签表里这是两个互斥角色); 还有一张开了 7 天
正文全空的 `needs-info` 僵尸票. 当时靠手拼 `gh` 命令逐张看, 结果正则写错一次,
把**有完整验证记录**的 #76 报成了"无去向" -- 读数的仪器自己就是乱源,
所以这件事得交给工具而不是交给手.

**判据来自 `docs/agents/triage-labels.md`**(五个多态角色, 一个角色一个标签,
与 `bug` / `enhancement` 那类类型标签并存不冲突). 它只读, 不改任何东西.

**它查什么**:
  1. 开着的票必须**恰好一个**角色标签: 0 个是漏 triage, 多个是自相矛盾.
  2. 已关闭的票不许挂**等待类**角色(`needs-triage` / `needs-info`),
     那是在说"还在等", 已关就是假话. `ready-for-*` 与 `wontfix` 反而要留 --
     那记录着这张票当初是怎么派出去的 / 为什么没做, 摘掉就把来历抹了.
  3. `wontfix` 与 `ready-for-*` 互斥: 前者说不会做, 后者说已可开做.
  4. **开着的**票不该零标签(否则在按标签过滤的队列里隐形). 已关闭的不查,
     理由见 `check_unlabeled` 的注释 -- 那是编造, 不是审计.
  5. `needs-info` 且正文与评论**都空**的是僵尸票.

**用法**: `uv run scripts/audit-issues.py`. 两个开关各多报一类**信息级**情况(都不算失败):

- `--trace`: 已关闭且非 `wontfix` 的票, 在提交历史里查无 `#编号` 点名(说明从票走不到代码).
  早期提交本来就没引用 issue 编号的惯例, 要改是改今后的规矩.
- `--citations`: 票里引的 `ADR-NNNN` 在当前语料里指不到哪一篇. 2026-10-17 那次重编号(28 篇
  并 13 篇)留下的旧号正落在这一类; 人拍板之后, 票的正文与评论**已按那张映射改齐**
  (2026-10-18, 见 `docs/evidence/numbering.md`), 这件工具留着盯**将来**再出的漂移.
  两个盲区: 号码落在当前 13 篇之内,当时指的却是别的篇的 -- 这次真靠它报的话只会报 15 张,
  实际 31 张; 另一处(只扫正文, 评论那半得另跑)2026-10-18 已补上 -- 重编号那次改的 42 条
  评论里的号, 现在这条也看得见.
- `--paths`: 票里点的 `docs/adr/` 与 `docs/evidence/` 篇路径在仓里找不到的. 2026-10-18 补:
  上一轮只对齐了 `ADR-NNNN` 那个**号**, 篇路径是另一类漏网(旧号 0012 / 0014 / 0031 那几处
  的路径当时没跟着换), 就是靠这条揪出来的. 它扫**正文与评论**: 评论那一半的正文
  `gh issue list --json` 本来就带着, 顺手补上 `--citations` 说的那个盲区.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

TAG = "[audit-issues]"

# 五个互斥的 triage 角色, 见 docs/agents/triage-labels.md.
ROLES = ("needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix")
# "还在等"的那两个: 票一关就必须摘掉, 否则报表里它永远像没结.
WAITING = ("needs-triage", "needs-info")
# 做成动作的那种: 关了也留着, 记录派工来历.
DISPATCH = ("ready-for-agent", "ready-for-human", "wontfix")

FIELDS = "number,title,state,body,labels,comments,createdAt,updatedAt"

#: 票正文里的引用形态: 与 `tests/test_adr_corpus.py` 同一批口径(并列写法 `ADR-0005/0006`
#: 里每个号都算 -- 上一轮重编号漏的正是这种半边). 顿号写成转义(`\u3001`): 中文标点是
#: 那半边守卫的禁字, 而这里要的是它的**语义**.
CITE = re.compile(r"ADR[- ]?(\d{3,4}(?:\s*[/,\u3001]\s*\d{3,4})*)")
CITE_SPLIT = re.compile(r"\s*[/,\u3001]\s*")
#: 票里点的语料路径: 只认本仓重写后那两处. 旧仓的代码路径(`src/domain/**` 那些)满票都是,
#: 那些由各票头顶的"已随 git 历史清除"处置注记兜着, 不在这里重复报.
DOC_PATH = re.compile(r"docs/(?:adr|evidence)/[\w.-]*\.md")

ROOT = Path(__file__).resolve().parents[1]


def fetch() -> list[dict]:
    try:
        raw = subprocess.run(
            ["gh", "issue", "list", "--state", "all", "--limit", "200", "--json", FIELDS],
            capture_output=True,
            check=True,
            text=True,
        ).stdout
    except FileNotFoundError:
        print(f"{TAG} 找不到 gh CLI, 请先安装并登录.", file=sys.stderr)
        raise SystemExit(2) from None
    except subprocess.CalledProcessError as exc:
        print(f"{TAG} gh 调用失败: {exc.stderr.strip()}", file=sys.stderr)
        raise SystemExit(2) from None
    return json.loads(raw)


def roles_of(issue: dict) -> list[str]:
    names = [lab["name"] for lab in issue["labels"]]
    return [name for name in names if name in ROLES]


def label_lines(issues: list[dict]) -> list[str]:
    return [
        f"  #{issue['number']} [{','.join(roles_of(issue)) or '无角色'}] {issue['title'][:44]}"
        for issue in issues
    ]


def check_open_without_role(issues: list[dict]) -> list[str]:
    """开票必须 triage 过: 一个角色都没有的 open 票没法派工."""
    return label_lines([i for i in issues if i["state"] == "OPEN" and not roles_of(i)])


def check_open_with_many_roles(issues: list[dict]) -> list[str]:
    """一个角色才说得通, 两个互相打脸的标签等于没说."""
    return label_lines([i for i in issues if i["state"] == "OPEN" and len(roles_of(i)) > 1])


def check_closed_waiting(issues: list[dict]) -> list[str]:
    """关票还挂"在等"是假话 -- 报表里它永远像没结."""
    bad = []
    for issue in issues:
        if issue["state"] != "CLOSED":
            continue
        held = [r for r in roles_of(issue) if r in WAITING]
        if held:
            bad.append(
                {
                    **issue,
                    "roles": f"{','.join(roles_of(issue))} <-- 关票不该留 {','.join(held)}",
                }
            )
    return label_lines(bad)


def check_dispatch_conflict(issues: list[dict]) -> list[str]:
    """wontfix 说不会做, ready-* 说已可开做, 一张票不能同时是两个."""
    bad = []
    for issue in issues:
        held = set(roles_of(issue))
        if "wontfix" in held and held & {"ready-for-agent", "ready-for-human"}:
            bad.append({**issue, "roles": ",".join(sorted(held)) + " <-- 互斥"})
    return label_lines(bad)


def check_unlabeled(issues: list[dict]) -> list[str]:
    """开着的票零标签 = 它在按标签过滤的工作队列里隐形.

    **只查开着的**: 已关闭的票是历史, 没标签不碍事. 逼它补一个反而更糟 --
    2026-10-11 #7(处置是"三选一全作废, 已定案")被这条报出来后, 我手上
    没有任何依据说它该是 `wontfix`(它没被放弃, 是被定案了)还是 `enhancement`,
    硬选一个就是编造. **工具不该要求它无法知道的信息.**
    """
    return label_lines([i for i in issues if i["state"] == "OPEN" and not i["labels"]])


def check_zombies(issues: list[dict], days: int) -> list[str]:
    """needs-info 且正文与评论都空 -- 没人知道要补什么, 也没人补得了."""
    out = []
    now = datetime.now(UTC)
    for issue in issues:
        if issue["state"] != "OPEN" or "needs-info" not in roles_of(issue):
            continue
        body = (issue.get("body") or "").strip()
        if body or issue.get("comments"):
            continue
        opened = datetime.fromisoformat(issue["createdAt"].replace("Z", "+00:00"))
        age = (now - opened).days
        if age >= days:
            out.append(f"  #{issue['number']} 开了 {age} 天, 正文空, 零评论: {issue['title'][:40]}")
    return out


def check_trace(issues: list[dict]) -> list[str]:
    """信息级: 关票在提交历史里查无 #编号 点名, 从票走不到代码."""
    try:
        log = subprocess.run(
            ["git", "log", "--all", "--oneline"],
            capture_output=True,
            check=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return ["  (拿不到 git log, 跳过)"]
    out = []
    for issue in issues:
        if issue["state"] != "CLOSED":
            continue
        held = set(roles_of(issue))
        if "wontfix" in held:
            continue  # 没做, 本就不该有 commit
        if f"#{issue['number']}" not in log:
            out.append(f"  #{issue['number']} {issue['title'][:44]}")
    return out


def check_citations(issues: list[dict], known: set[str]) -> list[str]:
    """信息级: 票里引的 `ADR-NNNN` 在当前语料里指不到哪一篇(重编号后的旧号多是这样).

    正文与评论都扫(2026-10-18 补): 上一轮重编号实际动过 42 条评论里的号, 而那时这条只读
    `gh issue list --json` 给的那份正文 -- 评论那半靠人肉另跑一遍. 号码落在当前篇数之内却
    指的是别的篇的, 这里查不出.
    """
    out = []
    for issue in issues:
        sides = [("", issue.get("body") or "")]
        sides += [(" 评论", c.get("body") or "") for c in issue.get("comments") or []]
        for side, text in sides:
            ghosts = {
                num
                for run in CITE.findall(text)
                for num in CITE_SPLIT.split(run)
                if num not in known
            }
            if ghosts:
                refs = ", ".join(f"ADR-{num}" for num in sorted(ghosts))
                out.append(f"  #{issue['number']}{side} 引不到 {refs}: {issue['title'][:36]}")
    return out


def current_adr_numbers() -> set[str]:
    """当前语料里的编号: `docs/adr/NNNN-*.md` 的文件名头四位(`README.md` 不算)."""
    return {
        path.stem[:4] for path in (ROOT / "docs" / "adr").glob("*.md") if path.name != "README.md"
    }


def check_doc_paths(issues: list[dict]) -> list[str]:
    """信息级: 票里点的 `docs/adr/` `docs/evidence/` 路径在仓里找不到的.

    与 `check_citations` 互补: 那一条量的是**号**指不指得到, 这一条量的是**篇路径**还在不在.
    正文与评论都扫 -- 上一轮漏的四处里有三处在评论里, 而 `gh issue list --json` 本来就把
    评论正文一起给了.
    """
    out = []
    for issue in issues:
        bodies = [issue.get("body") or ""]
        bodies += [c.get("body") or "" for c in issue.get("comments") or []]
        missing = sorted(
            {p for text in bodies for p in DOC_PATH.findall(text) if not (ROOT / p).is_file()}
        )
        if missing:
            out.append(f"  #{issue['number']} 点不到 {', '.join(missing)}: {issue['title'][:30]}")
    return out


def report(title: str, lines: list[str], level: str) -> bool:
    """打印一段; 有内容返回 True(= 算问题)."""
    if not lines:
        print(f"{TAG} {title}: 无")
        return False
    print(f"{TAG} {title}: {len(lines)} 张")
    for line in lines:
        print(line)
    print(f"{TAG}   ^ {level}")
    return True


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--zombie-days", type=int, default=7, help="needs-info 空票多少天算僵尸(默认 7)"
    )
    ap.add_argument(
        "--trace", action="store_true", help="额外报已关闭票在提交历史里的点名情况(信息级)"
    )
    ap.add_argument(
        "--citations", action="store_true", help="额外报正文里引不到的 ADR 编号(信息级)"
    )
    ap.add_argument(
        "--paths", action="store_true", help="额外报正文/评论里指不到的语料路径(信息级)"
    )
    args = ap.parse_args()

    issues = fetch()
    print(
        f"{TAG} 共 {len(issues)} 张票 "
        f"(开 {sum(1 for i in issues if i['state'] == 'OPEN')} / "
        f"关 {sum(1 for i in issues if i['state'] == 'CLOSED')})"
    )

    failed = False
    failed |= report("开着的票没有角色标签", check_open_without_role(issues), "补 triage")
    failed |= report("开着的票角色标签互斥冲突", check_open_with_many_roles(issues), "只留一个")
    failed |= report("已关闭却还挂着等待类标签", check_closed_waiting(issues), "摘掉 needs-*")
    failed |= report("wontfix 与 ready-* 同时在一张票上", check_dispatch_conflict(issues), "二选一")
    failed |= report("开着的票零标签", check_unlabeled(issues), "补类型标签")
    failed |= report(
        f"needs-info 僵尸票(>= {args.zombie_days} 天且无正文无评论)",
        check_zombies(issues, args.zombie_days),
        "补正文或关闭",
    )

    if args.trace:
        trace = check_trace(issues)
        print(f"{TAG} [信息] 已关闭但提交历史查无点名: {len(trace)} 张")
        for line in trace:
            print(line)

    if args.citations:
        known = current_adr_numbers()
        found = check_citations(issues, known)
        print(
            f"{TAG} [信息] 正文/评论引了当前语料里没有的 ADR 编号(现共 {len(known)} 篇): "
            f"{len(found)} 张"
        )
        for line in found:
            print(line)
        print(
            f"{TAG}   ^ 旧号到新号的映射(28 篇全在): `docs/evidence/numbering.md`. "
            "2026-10-18 已照它把票里的号改齐; 现在还有, 就是新出的漂移."
        )

    if args.paths:
        found = check_doc_paths(issues)
        print(f"{TAG} [信息] 票里点了仓里没有的语料路径: {len(found)} 张")
        for line in found:
            print(line)
        print(
            f"{TAG}   ^ 2026-10-18 补这条时揪出 4 处(旧号 0012 / 0014 / 0031 的篇路径没跟着号换), "
            "已改齐; 现在还有, 就是新出的漂移."
        )

    if failed:
        print(f"{TAG} 有问题要收拾 (退出码 1).")
        raise SystemExit(1)
    print(f"{TAG} 账面自洽.")


if __name__ == "__main__":
    main()
