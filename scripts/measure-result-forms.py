#!/usr/bin/env python3
"""把同一批**真实**工具结果按"今天的形态"与"结构化的形态"各量一遍(字符 + token).

**为什么要它**:ADR-0012 那条"真实形状上省不到(−4%)"当时只有 5 条**手造**样例(那篇
自己在未验证项里承认了),而它是"今天不建结构化通路"最要紧的一条论据.这个脚本把"真实
样本集"变成一条可复现的命令:

    uv run scripts/measure-result-forms.py grep --pattern '续聊' --pattern 'WORK_'

样本由 **dsb 自己的实现**跑出来(`dsb.work.grep_tree`,作用域是本仓),不是照着形状手写.
形态按 ADR-0012 记的那三种:

- `today`      今天真的发给模型的那一串(`路径:行号: 行`,换行分隔);
- `structured` 协议里结构化那半个字段的形态(键名逐条重复的紧凑 JSON);
- `toon`       TOON 表格形**上界**:键名一行表头,一行一条,Tab 分隔,**不做任何转义**
               --它省的正是重复键名,这里连代价都不算.若这个上界都不省,结论与口径无关.

token 用 `count-tokens.py` 的同一份分词器(缺了就只报字符,**不猜**).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent

COUNT_TOKENS = HERE / "count-tokens.py"

FORM_TODAY = "today"
FORM_STRUCTURED = "structured"
FORM_TOON = "toon"
FORMS = (FORM_TODAY, FORM_STRUCTURED, FORM_TOON)

#: `grep_tree` 的命中行形状(`路径:行号: 行`);脚注(截断说明)不匹配,自然被丢掉.
HIT = re.compile(r"^(?P<path>.+?):(?P<number>\d+): (?P<text>.*)$", re.DOTALL)

Hit = tuple[str, int, str]


def load_count_tokens() -> ModuleType:
    """借用 `count-tokens.py` 的分词器口径与"下一步"提示(那一份不复制)."""
    spec = importlib.util.spec_from_file_location("count_tokens_under_use", COUNT_TOKENS)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def token_counter() -> Callable[[str], int] | None:
    """回一个 `正文 → token 数` 的函数;分词器或 `tokenizers` 不在就回 None."""

    module = load_count_tokens()
    path = Path(module.DEFAULT_TOKENIZER)
    if not path.exists():
        return None
    try:
        from tokenizers import Tokenizer
    except ImportError:
        return None
    tokenizer = Tokenizer.from_file(str(path))
    return lambda body: len(tokenizer.encode(body).ids)


def parse_hits(text: str) -> list[Hit]:
    """把 `grep_tree` 的输出拆回 (路径, 行号, 行):脚注不算命中."""
    hits: list[Hit] = []
    for line in text.splitlines():
        match = HIT.match(line)
        if match is not None:
            hits.append((match.group("path"), int(match.group("number")), match.group("text")))
    return hits


def form_today(hits: Sequence[Hit]) -> str:
    return "\n".join(f"{path}:{number}: {text}" for path, number, text in hits)


def form_structured(hits: Sequence[Hit]) -> str:
    return json.dumps(
        [{"path": path, "number": number, "text": text} for path, number, text in hits],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def form_toon(hits: Sequence[Hit]) -> str:
    """表格形上界:表头一行 + 一行一条,Tab 分隔,不转义(`\\t` 在命中正文里几乎不出现)."""
    rows = ["\t".join(("path", "number", "text"))]
    rows.extend("\t".join((path, str(number), text)) for path, number, text in hits)
    return "\n".join(rows)


def render(hits: Sequence[Hit], counter: Callable[[str], int] | None) -> dict:
    """三种形态各量一遍:字符数是硬数,token 有分词器才算."""
    sizes: dict[str, dict[str, int]] = {}
    for form in FORMS:
        body = {"today": form_today, "structured": form_structured, "toon": form_toon}[form](hits)
        entry = {"chars": len(body)}
        if counter is not None:
            entry["tokens"] = counter(body)
        sizes[form] = entry
    return {"hits": len(hits), "forms": sizes}


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    grep = sub.add_parser("grep", help="在本仓上按 `dsb` 的 grep 跑若干模式,各量一遍")
    grep.add_argument("--pattern", action="append", required=True, help="正则;可给多次")
    grep.add_argument("--path", default=".", help="起点(相对本仓根),默认整个仓")
    grep.add_argument("--json", action="store_true", help="输出 JSON(给别的脚本吃)")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT))
    from dsb.work import WorkError, grep_tree  # noqa: PLC0415  (要用本仓的 dsb,放在 sys.path 之后)

    counter = token_counter()
    per_pattern: list[dict] = []
    for pattern in args.pattern:
        try:
            text = grep_tree(ROOT, pattern, args.path)
        except WorkError as error:
            sys.exit(f"模式 {pattern!r} 跑不动:{error.code}")
        measured = render(parse_hits(text), counter)
        per_pattern.append({"pattern": pattern, **measured})

    totals = {
        form: {
            key: sum(entry["forms"][form][key] for entry in per_pattern)
            for key in per_pattern[0]["forms"][form]
        }
        for form in FORMS
    }
    report = {
        "patterns": per_pattern,
        "totals": totals,
        "tokenized": counter is not None,
        "root": str(ROOT),
        "path": args.path,
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
        return

    # 表是给人看的:先逐模式,再合计与差异--"省不省"看的是最后那一行.
    def size_text(entry: dict, key: str) -> str:
        return f"{entry[key]:>9,}" if key in entry else f"{'-':>9}"

    print(f"样本:本仓 grep,{len(per_pattern)} 个模式,{totals[FORM_TODAY]['chars']:,} 字符起算")
    for key in ("chars", "tokens"):
        if key == "tokens" and counter is None:
            print("\n(没有分词器:只报字符.取法见 scripts/count-tokens.py 的文件头)")
            break
        print(f"\n== {key} ==")
        print(
            f"{'模式':<28}{'命中':>6}{'today':>10}{'structured':>12}{'toon':>10}{'toon/today':>12}"
        )
        for entry in per_pattern:
            today = entry["forms"][FORM_TODAY].get(key)
            toon = entry["forms"][FORM_TOON].get(key)
            ratio = f"{toon / today - 1:+.1%}" if today and toon is not None else "-"
            print(
                f"{entry['pattern']:<28}{entry['hits']:>6}"
                f"{size_text(entry['forms'][FORM_TODAY], key)}"
                f"{size_text(entry['forms'][FORM_STRUCTURED], key)}"
                f"{size_text(entry['forms'][FORM_TOON], key)}"
                f"{ratio:>12}"
            )
        total_today = totals[FORM_TODAY].get(key)
        total_toon = totals[FORM_TOON].get(key)
        ratio = f"{total_toon / total_today - 1:+.1%}" if total_today and total_toon else "-"
        print(
            f"{'合计':<28}{sum(e['hits'] for e in per_pattern):>6}"
            f"{size_text(totals[FORM_TODAY], key)}"
            f"{size_text(totals[FORM_STRUCTURED], key)}"
            f"{size_text(totals[FORM_TOON], key)}"
            f"{ratio:>12}"
        )


if __name__ == "__main__":
    main()
