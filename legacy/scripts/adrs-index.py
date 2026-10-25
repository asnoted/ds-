#!/usr/bin/env python3
"""生成/核对 `docs/adr/README.md` 这份 ADR 索引.

**为什么要有它**: 索引是读者进门第一眼看到的东西, 而**手写的索引迟早烂** -- 我不止一次
撞到过手抄表与代码对不上(对着 README 的限额表读, 发现"给模型看的结果"写着 2000 字, 代码
里是 16000; 那张表后来整段撤了, 教训留着). 索引与正文分离, 索引由工具生成, 它就不可能漂.

**用法**:
    uv run scripts/adrs-index.py           # 重新生成 docs/adr/README.md
    uv run scripts/adrs-index.py --check   # 只核对, 不合写回; 有出入退出码 1

`--check` 接进了 `pnpm quality:ci`(守卫只在 CI 跑), 所以"新增/删除/改动了一篇 ADR 却忘了
更新索引"在 CI 里就会红.

**它读什么**: 每篇 ADR 的 H1 与 `Status` / `Date` 两行头(`docs/agents/domain.md` 说这两行是
固定的). 有一处读不出就**退出码 1 并列出是哪篇**, 不悄悄生成一份缺字段的索引 -- 那是把烂账
藏进看起来正常的表格里(见 `broken`).

**它不读什么**: 正文. ADR 是**活文档**(见本文件), 当前口径就在每一篇里, 索引不重复它;
一次性实测在 `docs/evidence/`, 也不进这里. 骨架与"全仓引用指得到"那两条由
`tests/test_adr_corpus.py` 守(pytest 在本地也跑, 这里只管索引).
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
FIELD = re.compile(r"^- \*\*(Status|Date)\*\*:\s*(.+?)\s*$", re.M)
NUMBER = re.compile(r"(\d{3,4})")


def parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    num_m = NUMBER.match(path.stem)
    num = num_m.group(1) if num_m else path.stem
    # 取第一条 `# ` 行的标题. H1 可以带 `ADR-NNNN:` 前缀, 索引里统一剥掉, 免得同一列
    # 两种写法.
    title_m = H1.search(text)
    fields = {k: v for k, v in FIELD.findall(text)}
    return {
        "num": num,
        "title": title_m.group(1).strip() if title_m else "(没有 H1)",
        "status": fields.get("Status", "(缺)"),
        "date": fields.get("Date", "(缺)"),
        "path": path.as_posix(),
    }


def render(entries: list[dict]) -> str:
    out: list[str] = []
    out.append("# ADR 索引")
    out.append("")
    out.append(
        "> **本文件是生成的, 手改会被 `pnpm quality:ci` 判红.** 重新生成: "
        "`uv run scripts/adrs-index.py`; 只核对: `uv run scripts/adrs-index.py --check`."
    )
    out.append(">")
    out.append(
        f"> 由 `scripts/adrs-index.py` 扫 {len(entries)} 篇 ADR 生成. "
        "判据与格式见该脚本的文档字符串."
    )
    out.append("")
    out.append(f"## {len(entries)} 篇")
    out.append("")
    out.append("| 号 | 标题 | 状态 | 日期 |")
    out.append("| --- | --- | --- | --- |")
    for e in sorted(entries, key=lambda x: x["num"]):
        out.append(f"| {e['num']} | {e['title']} | {e['status']} | {e['date']} |")
    out.append("")
    out.append("## 怎么用这份索引")
    out.append("")
    out.append(
        "**每一篇写的是当前口径**: 口径变了就改那一篇(连 `Date` 一起改), 不另开一篇去"
        '"修订/取代"它; 一次性的实测记录在 `docs/evidence/`, 正文里点名.'
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
    # 读不出头两行与标题的, 当场报出来 -- 上一版就把 21 篇标题全读成"(没有 H1)"
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
            # 提示按"整个文件里有没有出现这个号"来判: 只认表格行会误报(第一版就误报过一次).
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
