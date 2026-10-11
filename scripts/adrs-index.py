#!/usr/bin/env python3
"""生成/核对 `docs/adr/README.md` 这份 ADR 索引.

**为什么要有它**: 本仓 21 篇 ADR 此前**没有任何索引** -- `AGENTS.md` 只说了一句
"root `GLOSSARY.md` + `docs/adr/`", 要找某个决策只能 `ls` 再逐个读文件名, 更看不出
哪几篇已被后来者取代. 对照 Firefox 的做法(`browser/docs/index.md` 那份 toctree):
**索引与正文分离, 索引由工具生成, 所以它不可能与正文漂**. 手写索引迟早烂 -- 我今天
已经在 README 的限额表上撞到一次("给模型看的结果 2000 字", 代码里是 16000).

**用法**:
    uv run scripts/adrs-index.py           # 重新生成 docs/adr/README.md
    uv run scripts/adrs-index.py --check   # 只核对, 不合写回; 有出入退出码 1

`--check` 接进了 `pnpm quality`, 所以"新增了一篇 ADR 却忘了更新索引"当场就会红.

**它读什么**: 每篇 ADR 的 H1 与 `Status` / `Date` / `Supersedes` 三行头
(`docs/agents/domain.md` 说这三行是固定的). 有一处读不出就**退出码 1 并列出是哪篇**,
不悄悄生成一份缺字段的索引 -- 那是把烂账藏进看起来正常的表格里(见 `broken`).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TAG = "[adrs-index]"
ADR_DIR = Path("docs/adr")
OUT = ADR_DIR / "README.md"

H1 = re.compile(r"^#\s*(?:ADR-\d{3,4}\s*[::]\s*)?(.+)$", re.M)
FIELD = re.compile(r"^- \*\*(Status|Date|Supersedes)\*\*:\s*(.+?)\s*$", re.M)
NUMBER = re.compile(r"(\d{3,4})")
SUP = re.compile(r"ADR-(\d{3,4})")


def parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    num_m = NUMBER.match(path.stem)
    num = num_m.group(1) if num_m else path.stem
    # 取第一条 `# ` 行的标题. 多数篇的 H1 就是标题本身(不带 ADR-NNNN 前缀),
    # 0017 那种带前缀的要剥掉, 否则索引里同一列两种写法.
    title_m = H1.search(text)
    fields = {k: v for k, v in FIELD.findall(text)}
    sup_raw = fields.get("Supersedes", "(缺)")
    # `Supersedes: none(某句被局部修订)` **不是取代** -- 括号里是补充说明.
    # 2026-10-11 起初没剥括号, 于是 0011 与 0012 在索引里"互相取代"了, 那是编的.
    head = sup_raw.split("(", 1)[0].strip()
    return {
        "num": num,
        "title": title_m.group(1).strip() if title_m else "(没有 H1)",
        "status": fields.get("Status", "(缺)"),
        "date": fields.get("Date", "(缺)"),
        # 只取被它点名的编号; `none(...)` 这类一句修订不算取代.
        "supersedes": SUP.findall(head) if head != "none" else [],
        "sup_raw": sup_raw,
        "path": path.as_posix(),
    }


def render(entries: list[dict]) -> str:
    by_num = {e["num"]: e for e in entries}
    # "已被取代"不看它自己的 Status -- 已接受的 ADR 不可变, 被推翻那篇的 Status
    # 仍然是 accepted, 真实信号在**别人有没有点名它**.
    killed = {t for e in entries for t in e["supersedes"]}
    live = [e for e in entries if e["num"] not in killed]
    dead = [e for e in entries if e["num"] in killed]

    out: list[str] = []
    out.append("# ADR 索引")
    out.append("")
    out.append(
        "> **本文件是生成的, 手改会被 `pnpm quality` 判红.** 重新生成: "
        "`uv run scripts/adrs-index.py`; 只核对: `uv run scripts/adrs-index.py --check`."
    )
    out.append(">")
    out.append(
        f"> 由 `scripts/adrs-index.py` 扫 {len(entries)} 篇 ADR 生成. "
        "判据与格式见该脚本的文档字符串."
    )
    out.append("")
    out.append(f"## 在册({len(live)} 篇)")
    out.append("")
    out.append("| 号 | 标题 | 状态 | 日期 | 取代了 |")
    out.append("| --- | --- | --- | --- | --- |")
    for e in sorted(live, key=lambda x: x["num"]):
        supers = ", ".join(f"ADR-{n}" for n in e["supersedes"]) or "-"
        out.append(f"| {e['num']} | {e['title']} | {e['status']} | {e['date']} | {supers} |")
    out.append("")
    out.append("## 已被取代")
    out.append("")
    if not dead:
        out.append("(没有 -- 到目前为止没人写过新篇去推翻旧篇.)")
    else:
        killer = {t: e["num"] for e in entries for t in e["supersedes"]}
        for e in sorted(dead, key=lambda x: x["num"]):
            by = killer.get(e["num"], "?")
            target = by_num.get(by)
            tail = f" -- {target['title']}" if target else ""
            out.append(f"- **ADR-{e['num']}** {e['title']}")
            out.append(f"  - 由 ADR-{by} 取代{tail}")
            out.append(f"  - **照它做的请改看 ADR-{by}**; 本篇一字不改, 留着看演进过程.")
    out.append("")
    out.append("## 怎么用这份索引")
    out.append("")
    out.append(
        "**已接受的 ADR 不可变**: 要推翻就写新篇, 在它的 `Supersedes:` 里点名旧篇, "
        "旧文件一个字不改. 见 `docs/agents/domain.md`."
    )
    out.append("")
    out.append(
        "读 ADR 前先读根目录 `GLOSSARY.md` -- 输出提到领域概念时要用词条里的词, 不要漂到同义词."
    )
    out.append("")
    return "\n".join(out)


SEP_ROW = re.compile(r"^\|[\s\-:|]+\|$")


def normalize(text: str) -> str:
    """比对前抹掉纯排版差异.

    **为什么必须有它**: 提交进仓库的那份会被 prettier 排一遍 -- 它给 Markdown 表格
    补齐列宽空格, 还把分隔行的横杠数量按列宽铺开; 而生成器输出的是紧凑写法. 逐字节
    比对会因此报"不一致", 那是排版不是内容 (2026-10-11 第一版就是这样判红的,
    先栽在列宽上, 又栽在横杠数量上). 让生成器去复刻 prettier 的对齐算法才是错的方向
    (迟早漂), 所以这里把空白折掉, 并把分隔行整行归一 -- 横杠几个不带语义.
    """
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        out.append("| --- |" if SEP_ROW.match(stripped) else " ".join(stripped.split()))
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--check", action="store_true", help="只核对, 不写回; 有出入退出码 1")
    args = ap.parse_args()

    files = sorted(p for p in ADR_DIR.glob("*.md") if p.name != "README.md")
    if not files:
        print(f"{TAG} {ADR_DIR} 里没有 ADR, 无可生成.", file=sys.stderr)
        raise SystemExit(2)

    entries = [parse(p) for p in files]
    # 读不出头三行与标题的, 当场报出来 -- 上一版就把 21 篇标题全读成"(没有 H1)"
    # 而照样生成了一份**看起来很正常**的索引, 那比不生成更坏.
    broken = [
        f"{e['path']}: {k}={e[k]}"
        for e in entries
        for k in ("title", "status", "date")
        if e[k].startswith("(") or e[k] == "(缺)"
    ]
    if broken:
        for line in broken:
            print(f"{TAG} 读不出: {line}", file=sys.stderr)
        print(f"{TAG} 有 {len(broken)} 处头信息读不出, 先修 ADR 再生成索引.", file=sys.stderr)
        raise SystemExit(1)

    wanted = render(entries)

    if args.check:
        if not OUT.exists():
            print(
                f"{TAG} 缺 {OUT.as_posix()} -- 跑 `uv run scripts/adrs-index.py` 生成.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        have = normalize(OUT.read_text(encoding="utf-8"))
        if have != normalize(wanted):
            # 提示按"整个文件里有没有出现这个号"来判: 被取代的那几篇不在表格里,
            # 在下面另一节; 只认表格行会误报"少了"它(第一版就误报了 0017).
            missing = [e["num"] for e in entries if e["num"] not in have]
            hint = f"(索引里完全没有 {', '.join(missing)})" if missing else "(内容与 ADR 正文不符)"
            print(f"{TAG} 索引与 ADR 正文不一致 {hint}", file=sys.stderr)
            print(f"{TAG} 跑 `uv run scripts/adrs-index.py` 重新生成.", file=sys.stderr)
            raise SystemExit(1)
        print(f"{TAG} 索引与 {len(entries)} 篇 ADR 一致.")
        return

    OUT.write_text(wanted, encoding="utf-8")
    print(f"{TAG} 写好 {OUT.as_posix()} ({len(entries)} 篇).")


if __name__ == "__main__":
    main()
