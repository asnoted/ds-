"""守卫: `docs/CODING_STANDARDS.md` 的编号引用必须指得到那一节.

判断题的条目被源码按"第 N 条"引用(`src/lib/armed.ts` 与 `src/lib/sendpace.ts` 指第 1 条,
ADR-0005 指第一条). 编号丢了引用还在, 没有编译器会报 -- #97 就是这么烂的, 靠巡检撞出来的.
这里拿文档自己的节标题当唯一事实源, 扫全仓引用.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.docs

DOC = ROOT / "docs" / "CODING_STANDARDS.md"

#: 被扫的源码面: 与标点守卫同一批口径 -- 别人家的(`.agents/` `vendor/`)与
#: 真机原件(`protocol/evidence/`)不碰.
SCANNED_ROOTS = (
    "src",
    "entrypoints",
    "dsb",
    "scripts",
    "docs",
    "tests",
    "protocol",
    ".github",
    ".husky",
)

SCANNED_FILES = ("AGENTS.md", "README.md", "GLOSSARY.md")

SUFFIXES = frozenset(
    {".md", ".py", ".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml", ".toml", ".sh", ".html"}
)

#: 引用形态: `CODING_STANDARDS(.md)` 之后 40 字符内的"第 N 条/节/章"(数字或中文数字).
REFERENCE = re.compile(
    r"CODING_STANDARDS(?:\.md)?[^\n]{0,40}第\s*([0-9]+|[一二三四五六七八九十]+)\s*[条节章]"
)

HEADING = re.compile(r"^##\s+(\d+)\.", re.MULTILINE)

CN_NUMERALS = {
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
}


def section_ids() -> set[int]:
    return {int(m.group(1)) for m in HEADING.finditer(DOC.read_text(encoding="utf-8"))}


def scanned_files() -> Iterator[Path]:
    for name in SCANNED_FILES:
        yield ROOT / name
    for root in SCANNED_ROOTS:
        for path in sorted((ROOT / root).rglob("*")):
            if path.is_file() and path.suffix in SUFFIXES:
                yield path


def referenced_section(raw: str) -> int:
    return int(raw) if raw.isdigit() else CN_NUMERALS[raw]


def test_coding_standards_references_resolve() -> None:
    existing = section_ids()
    dangling = [
        f"{path.relative_to(ROOT)}:{lineno}: {m.group(0)}"
        for path in scanned_files()
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        for m in REFERENCE.finditer(line)
        if referenced_section(m.group(1)) not in existing
    ]
    assert not dangling, "引用了不存在的节(补回该节, 或改指正确落点):\n" + "\n".join(dangling)


def test_coding_standards_sections_are_contiguous() -> None:
    """节编号必须从 1 起连续: 引用守卫只查"被引的节在不在", 查不出"节自己少了".

    §1 与 §2 曾在同一次 merge 里一起丢, 两次都是人眼撞见的(#97 与 spec #96 的
    review 修复批). 编号断了就红, 这类静默丢失到此为止.
    """
    ids = sorted(section_ids())
    expected = list(range(1, len(ids) + 1))
    assert ids and ids[0] == 1, f"§1 不在(现有节: {ids}) -- 判断题的第一条丢了"
    assert ids == expected, (
        "节编号不连续, 中间有节丢了(从 git 历史把它逐字恢复回来, 别重写):\n"
        f"  现有: {ids}\n  应为: {expected}"
    )
