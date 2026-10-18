"""守卫: `docs/probe.md` 的表必须点名仓里真有的东西 -- 子命令表对 `scripts/page-action.py`
的 argparse 定义, 探针脚本表对 `scripts/*probe*.py` 的文件.

表是 agent 读探针的第一站, 却靠手写维护: 加了子命令忘了补表, 读的人就以为那个动作
不存在 -- `list` 与 `focus` 就这么漏在表外很久. 没有编译器会报这种事, 所以拿
argparse 的定义与目录里的文件当唯一事实源, 两边对拍.

只扫 `## 子命令` 下面**第一张**表, 与表头是 `脚本` 的那张表.
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

#: 独立探针脚本: 名字里带 `probe`(表里那三行都这样). 新加一个不这么命名的探针, 这条守不到 --
#: 那时把名字对齐, 或者把这里放宽.
PROBE_SCRIPT_NAME = re.compile(r"scripts/[a-z0-9-]*probe[a-z0-9-]*\.py")


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


def table_with_header(first_cell: str) -> list[list[str]]:
    """按表头第一格认表(表不止一张, 靠内容而不是位置认), 连表头与分隔行一起给."""
    rows: list[list[str]] = []
    for line in PROBE_DOC.read_text(encoding="utf-8").splitlines():
        if line.startswith("|"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if not rows and cells[0] != first_cell:
                continue
            rows.append(cells)
        elif rows:
            break
    return rows


def documented_rows() -> list[list[str]]:
    """表里真讲了子命令的那些行(表头与分隔行用 `NAME` 筛掉)."""
    return [row for row in table_with_header("子命令") if NAME.search(row[0])]


def probe_script_rows() -> list[list[str]]:
    """探针脚本表里真点了脚本的那些行."""
    return [row for row in table_with_header("脚本") if PROBE_SCRIPT_NAME.search(row[0])]


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


def test_every_probe_script_is_in_the_scripts_table() -> None:
    listed = {name for row in probe_script_rows() for name in PROBE_SCRIPT_NAME.findall(row[0])}
    on_disk = {f"scripts/{path.name}" for path in (ROOT / "scripts").glob("*probe*.py")}
    missing = sorted(on_disk - listed)
    assert not missing, (
        f"docs/probe.md 的探针脚本表少了 {missing} -- 真机腿要留一行给人走, "
        f"不然读的人以为它不存在(与 `list`/`focus` 那次同一个漏法)"
    )


def test_every_probe_script_row_points_at_a_file() -> None:
    for row in probe_script_rows():
        name = PROBE_SCRIPT_NAME.findall(row[0])[0]
        assert (ROOT / name).is_file(), (
            f"docs/probe.md 探针脚本表里的 `{name}` 仓里没有(挪了家 / 改了名就把这行一起改)"
        )
