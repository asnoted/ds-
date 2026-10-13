"""守卫: `docs/CODING_STANDARDS.md` 的编号引用必须指得到那一节.

判断题的条目被源码按"第 N 条"引用(`src/lib/armed.ts` 与 `src/lib/sendpace.ts` 指第 1 条,
ADR-0025 指第一条). 编号丢了引用还在, 没有编译器会报 -- #97 就是这么烂的, 靠巡检撞出来的.
这里拿文档自己的节标题当唯一事实源, 扫全仓引用.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

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
