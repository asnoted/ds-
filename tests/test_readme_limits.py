"""守卫: README 的「限额与超时」表必须和代码里的常量对得上.

那张表是人手抄的, 抄完就没人回头看 -- 2026-10-11 对账时发现"给模型看的结果"那行还写着
2000 字, 而代码早在 ADR-0010 就改成了 16000(README 自己记了这笔). 这里拿代码当唯一事实
源: 每行按"项"认, 数值由常量重算, 表里必须出现同一种写法; 落点那列点的名字也得真的在代码
里(常量名本身, 或常量持有的那个字面量 -- 三个超时行点的是 env 键).

表里新加一行会红, 那是故意的: 加行的人顺手把它接进下面的 `ROWS`.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
GATEWAY = ROOT / "dsb" / "gateway.py"
WORK = ROOT / "dsb" / "work.py"
RELAY = ROOT / "src" / "lib" / "relay.ts"
ROUNDS = ROOT / "src" / "lib" / "rounds.ts"
CONTINUATION = ROOT / "src" / "lib" / "continuation.ts"

SECTION = "## 限额与超时"

TS_CONSTANT = re.compile(r"^export const (\w+) = ([0-9][0-9_]*);$", re.MULTILINE)


class Placement(NamedTuple):
    """落点列怎么点这一行: `literal` 为真时点的是常量持有的字面量(env 键), 否则是常量名."""

    constant: str
    literal: bool = False


class Row(NamedTuple):
    """表里一行: 项, 数值常量的落点, 把值渲染成表里的写法, 落点列怎么点它."""

    label: str
    source: Path
    value: str
    render: Callable[[float], str]
    placement: Placement


ROWS = (
    Row(
        "单次结果",
        GATEWAY,
        "MAX_RESULT_CHARS",
        lambda n: f"{n // 1024}K 字",
        Placement("MAX_RESULT_CHARS"),
    ),
    Row(
        "工作工具一条结果",
        WORK,
        "WORK_RESULT_CHARS",
        lambda n: f"{n} 字",
        Placement("WORK_RESULT_CHARS"),
    ),
    Row(
        "单服务工具",
        GATEWAY,
        "MAX_TOOLS_PER_SERVER",
        lambda n: f"{n} 件",
        Placement("MAX_TOOLS_PER_SERVER"),
    ),
    Row(
        "一轮围栏",
        RELAY,
        "MAX_CALLS_PER_ROUND",
        lambda n: f"{n} 块",
        Placement("MAX_CALLS_PER_ROUND"),
    ),
    Row(
        "自动续聊",
        ROUNDS,
        "MAX_CONTINUATION_ROUNDS",
        lambda n: f"{n} 轮",
        Placement("MAX_CONTINUATION_ROUNDS"),
    ),
    Row(
        "给模型看的结果",
        CONTINUATION,
        "MAX_RESULT_CHARS",
        lambda n: f"{n} 字",
        Placement("MAX_RESULT_CHARS"),
    ),
    Row(
        "单条输入的 token 预算",
        CONTINUATION,
        "MAX_SAFE_INPUT_TOKENS",
        lambda n: f"{n:,} token",
        Placement("MAX_SAFE_INPUT_TOKENS"),
    ),
    Row(
        "握手超时",
        GATEWAY,
        "START_TIMEOUT",
        lambda n: f"{n:g}s",
        Placement("CONNECT_TIMEOUT_ENV_KEY", literal=True),
    ),
    Row(
        "发现超时",
        GATEWAY,
        "DISCOVERY_TIMEOUT",
        lambda n: f"{n:g}s",
        Placement("DISCOVERY_TIMEOUT_ENV_KEY", literal=True),
    ),
    Row(
        "调用超时",
        GATEWAY,
        "DEFAULT_TOOL_TIMEOUT",
        lambda n: f"{n:g}s",
        Placement("TOOL_TIMEOUT_ENV_KEY", literal=True),
    ),
    Row(
        "`grep` 墙钟",
        WORK,
        "WORK_GREP_DEADLINE",
        lambda n: f"{n:g}s",
        Placement("WORK_GREP_DEADLINE"),
    ),
)


def literal(node: ast.expr) -> object:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.BinOp):
        left, right = literal(node.left), literal(node.right)
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
    raise AssertionError(f"只认字面量与乘除, 不认这种常量写法: {ast.dump(node)}")


def constant(path: Path, name: str) -> int | float | str:
    """按后缀读 `.ts` / `.py` 里的常量值; 读不到就报出来(表点了改名/搬走的东西)."""
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".ts":
        found = {
            match.group(1): int(match.group(2).replace("_", ""))
            for match in TS_CONSTANT.finditer(text)
        }
        assert name in found, f"{path.relative_to(ROOT)} 里没有 `export const {name} = <数>;`"
        return found[name]
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        else:
            continue
        if any(isinstance(t, ast.Name) and t.id == name for t in targets):
            return literal(node.value)  # type: ignore[return-value]
    raise AssertionError(f"{path.relative_to(ROOT)} 里没有模块级 {name}")


def table_rows() -> dict[str, str]:
    """把那张表读成 {项: 整行原文}; 整行是故意的 -- 判据只问"表里有没有这个写法"."""
    section = README.read_text(encoding="utf-8").split(SECTION, 1)[1].split("\n## ", 1)[0]
    lines = [line for line in section.splitlines() if line.startswith("|")]
    rows: dict[str, str] = {}
    for line in lines[1:]:  # 第一行是列名
        first = line.strip().strip("|").split("|")[0].strip()
        if set(first) <= {"-", ":"}:  # 表头与列名之间那行分隔线
            continue
        rows[first] = line
    return rows


def test_readme_limits_match_code() -> None:
    rows = table_rows()
    problems: list[str] = []
    for row in ROWS:
        line = rows.get(row.label)
        if line is None:
            problems.append(f"表里没有「{row.label}」这一行")
            continue
        value = constant(row.source, row.value)
        shown = row.render(value)
        if shown not in line:
            problems.append(
                f"「{row.label}」对不上: {row.source.relative_to(ROOT)} 的 {row.value} 是 "
                f"{value}, 表里该出现 `{shown}`"
            )
        held = constant(row.source, row.placement.constant)
        pointed = str(held) if row.placement.literal else row.placement.constant
        if pointed not in line:
            problems.append(
                f"「{row.label}」的落点没点 `{pointed}`(读的是 {row.placement.constant})"
            )
    unclaimed = sorted(set(rows) - {row.label for row in ROWS})
    if unclaimed:
        problems.append(f"表里有没接进守卫的行 {unclaimed}: 加进本文的 ROWS(数值与落点各一项)")
    assert not problems, "README 的限额表与代码对不上:\n" + "\n".join(problems)
