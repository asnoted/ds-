"""守卫: `docs/probe.md` 的子命令表必须点名 `scripts/page-action.py` 的每个子命令.

表是 agent 读探针的第一站, 却靠手写维护: 加了子命令忘了补表, 读的人就以为那个动作
不存在 -- `list` 与 `focus` 就这么漏在表外很久. 没有编译器会报这种事, 所以拿
argparse 的定义当唯一事实源, 两边对拍.

只扫 `## 子命令` 下面**第一张**表(独立探针脚本那张表讲的是别的脚本, 不是子命令).
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PROBE_DOC = ROOT / "docs" / "probe.md"
PROBE_SCRIPT = ROOT / "scripts" / "page-action.py"

SECTION = "## 子命令"

#: 子命令名长这样; 表头的 `子命令` 与分隔行的 `---` 都不匹配, 靠它把两者筛掉.
NAME = re.compile(r"[a-z][a-z0-9-]*")


def subcommands() -> set[str]:
    """`main()` 里 `sub.add_parser("...")` 报出来的名字."""
    tree = ast.parse(PROBE_SCRIPT.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not (isinstance(node.func, ast.Attribute) and node.func.attr == "add_parser"):
            continue
        if node.args and isinstance(node.args[0], ast.Constant):
            names.add(str(node.args[0].value))
    return names


def first_table() -> list[list[str]]:
    lines = PROBE_DOC.read_text(encoding="utf-8").splitlines()
    table: list[list[str]] = []
    for line in lines[lines.index(SECTION) :]:
        if line.startswith("|"):
            table.append([cell.strip() for cell in line.strip().strip("|").split("|")])
        elif table:
            break
    return table


def documented_rows() -> list[list[str]]:
    """表里真讲了子命令的那些行(表头与分隔行用 `NAME` 筛掉)."""
    return [row for row in first_table() if NAME.search(row[0])]


def test_every_subcommand_is_in_the_table() -> None:
    listed = {name for row in documented_rows() for name in NAME.findall(row[0])}
    missing = sorted(subcommands() - listed)
    assert not missing, (
        f"docs/probe.md 的子命令表少了 {missing} -- "
        f"page-action.py 有, 表里读不到(补一行, 别让读的人以为它不存在)"
    )


def test_every_table_row_names_a_subcommand() -> None:
    known = subcommands()
    for row in documented_rows():
        first = NAME.findall(row[0])[0]
        assert first in known, (
            f"docs/probe.md 子命令表里的 `{first}` 不是 page-action.py 的子命令"
            f"(表写岔了, 或者子命令被改了名没改表)"
        )
