"""守卫: `docs/adr/` 这份语料的两条不变量 -- 骨架与引用.

ADR 是活文档(ADR-0001): 改口径就地改那一篇, 不另开新篇去"修订/取代". 好处是读一篇就够,
代价是**两样东西没有编译器管**:

- **骨架**: 一篇 ADR 少了一个固定节(比如 `## Consequences`), 或者 H1 的编号与文件名对不
  上, 谁都不会红 -- 直到有人按它去复现, 或者按索引点不到那篇.
- **引用**: 全仓引用 `ADR-NNNN` 的地方(注释, 测试标题, fixture 的 `description`, 探针的
  report 字符串)漏改一处, 也没有编译器会红. 2026-10-17 那次重编号(28 篇并 13 篇)就是靠
  人肉 `grep` 扫的, 扫出 6 处悬空 -- 这两条守卫是那次教训的产物.

`tests/test_coding_standards_refs.py` 是同一类守卫(引用了 `docs/CODING_STANDARDS.md` 的
节号); 那条既然落在 tests/, 这条也落这里, 于是本地 `pnpm quality` 与 CI 都跑得到.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADR_DIR = ROOT / "docs" / "adr"

#: 被扫的引用面: 本仓自己的那些目录. 别人家的(`.agents/` / `vendor/`)与生成物不碰;
#: 手维护的存证(`protocol/evidence/controls.json`)与实测记录(`docs/evidence/`)**在扫**
#: -- 里面的编号同样会悬空(那次重编号就在 `controls.json` 的 `description` 上留了一处).
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

#: 根层的文件也扫(按后缀, 于是 `README.md` / `wxt.config.ts` / `package.json` 都在内):
#: 那次重编号漏改过 `wxt.config.ts`, 而它不在上面任何一个目录里.
#: 锁文件是 pnpm 生成的, 里头可能有别人的 `ADR-` 字样, 扫它只会有假报.
ROOT_FILE_SKIP = frozenset({"pnpm-lock.yaml"})

SUFFIXES = frozenset(
    {".md", ".py", ".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml", ".sh", ".html"}
)

#: 每篇必须有的四个节, 且按这个顺序出现. 别的节(已知洞 / 未验证项 / 自己的小节)随便加.
REQUIRED_SECTIONS = (
    "## 决定",
    "## Considered Options",
    "## Consequences",
    "## 判据(怎么自己复现)",
)

H1_TITLED = re.compile(r"^#\s*ADR-(\d{3,4})\s*[::]\s*(\S.*)$", re.M)
HEADING = re.compile(r"^##\s+(.+?)\s*$", re.M)

#: 引用形态: `ADR-0007`, `ADR 0007`, 以及并列写法 `ADR-0007/0006` -- 后者每个号都算.
CITE = re.compile(r"ADR[- ]?(\d{3,4}(?:\s*[/,、]\s*\d{3,4})*)")
CITE_SPLIT = re.compile(r"\s*[/,、]\s*")


def adr_files() -> list[Path]:
    return sorted(p for p in ADR_DIR.glob("*.md") if p.name != "README.md")


def adr_numbers() -> set[str]:
    return {p.stem[:4] for p in adr_files()}


def skeleton_problems(path: Path) -> list[str]:
    """一篇 ADR"长得像不像一篇 ADR";空列表 = 过关."""
    text = path.read_text(encoding="utf-8")
    name = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()
    bad: list[str] = []

    titled = H1_TITLED.search(text)
    if titled is None:
        bad.append(f"{name}: H1 不是 `# ADR-NNNN: 标题`")
    elif titled.group(1) != path.stem[:4]:
        bad.append(f"{name}: H1 的编号 {titled.group(1)} 与文件名对不上")

    # 开篇段: H1 与头两行之后, 第一个 `## ` 之前, 得有一句真话(索引与读者都靠它知道
    # "这篇讲什么"); 没有它会让人以为是文件头的一部分.
    head = text.split("\n## ", 1)[0]
    body = [line for line in head.splitlines()[1:] if not line.startswith("- **")]
    if not any(line.strip() for line in body):
        bad.append(f"{name}: 头两行下面没有开篇段")

    headings = [f"## {title}" for title in HEADING.findall(text)]
    places = [headings.index(want) if want in headings else -1 for want in REQUIRED_SECTIONS]
    bad += [
        f"{name}: 缺 {want}" for want, at in zip(REQUIRED_SECTIONS, places, strict=True) if at < 0
    ]
    if all(at >= 0 for at in places) and places != sorted(places):
        bad.append(f"{name}: 四个固定节的顺序不对(要 {' -> '.join(REQUIRED_SECTIONS)})")
    return bad


def citations(text: str) -> Iterator[str]:
    for run in CITE.findall(text):
        yield from CITE_SPLIT.split(run)


def cite_problems(files: Iterable[Path], known: set[str]) -> list[str]:
    """返回"这个号指不到篇章"的清单(`ADR-0007 <- 文件:行`);空列表 = 都指得到."""
    hits: dict[str, list[str]] = {}
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        shown = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()
        for lineno, line in enumerate(text.splitlines(), 1):
            for num in citations(line):
                if num not in known:
                    hits.setdefault(num, []).append(f"{shown}:{lineno}")
    return [f"ADR-{num} <- {', '.join(where[:4])}" for num, where in sorted(hits.items())]


def scanned_files() -> Iterator[Path]:
    for path in sorted(ROOT.iterdir()):
        if path.is_file() and path.suffix in SUFFIXES and path.name not in ROOT_FILE_SKIP:
            yield path
    for root in SCANNED_ROOTS:
        for path in sorted((ROOT / root).rglob("*")):
            if path.is_file() and path.suffix in SUFFIXES:
                yield path


def test_the_scanned_set_covers_the_files_that_got_missed_last_time() -> None:
    """守卫自己也要有判据: 根层的文件在扫(那次重编号漏的正是 `wxt.config.ts`)."""
    scanned = {path.relative_to(ROOT).as_posix() for path in scanned_files()}
    assert "wxt.config.ts" in scanned
    assert "README.md" in scanned
    assert "protocol/evidence/controls.json" in scanned


def test_every_adr_has_the_skeleton() -> None:
    problems = [p for path in adr_files() for p in skeleton_problems(path)]
    assert not problems, "ADR 骨架不对(缺节 / 顺序 / H1 编号);口径见 ADR-0001 与 README.md:\n" + (
        "\n".join(problems)
    )


def test_every_citation_resolves() -> None:
    problems = cite_problems(scanned_files(), adr_numbers())
    assert not problems, (
        "引用了不存在的 ADR 编号(改引用, 或补那一篇;重编号时全仓一起改):\n" + "\n".join(problems)
    )


def test_adr_numbers_are_unique() -> None:
    """同一号两篇 = 引用指向不明(`docs/adr/0007-a.md` 与 `0007-b.md` 都在)。"""
    stems = [p.stem[:4] for p in adr_files()]
    dupes = sorted({s for s in stems if stems.count(s) > 1})
    assert not dupes, f"编号重复: {', '.join(dupes)}"


def test_skeleton_check_fires(tmp_path: Path) -> None:
    """守卫自己也要有判据: 半成品必须被判出来, 不然这条守卫只是装饰."""
    half = tmp_path / "0007-half-baked.md"
    half.write_text(
        "# ADR-0007: 半成品\n\n- **Status**: accepted\n- **Date**: 2026-10-17\n\n一句话.\n\n"
        "## 决定\n\n1. 有.\n",
        encoding="utf-8",
    )
    problems = skeleton_problems(half)
    assert any("Considered Options" in p for p in problems)
    assert any("判据" in p for p in problems)


def test_skeleton_check_fires_on_number_mismatch(tmp_path: Path) -> None:
    off = tmp_path / "0007-mismatch.md"
    off.write_text(
        "# ADR-0008: 编号写错了\n\n- **Status**: accepted\n- **Date**: 2026-10-17\n\n"
        "一句话.\n\n## 决定\n\n## Considered Options\n\n## Consequences\n\n## 判据(怎么自己复现)\n",
        encoding="utf-8",
    )
    assert any("对不上" in p for p in skeleton_problems(off))


def test_citation_check_fires(tmp_path: Path) -> None:
    """并列写法里的第二个号也要查 -- 上一轮重编号漏的正是这种半边."""
    ghost = "ADR-" + "9" * 4  # 拼出来, 免得本文件自己被这条守卫报
    note = tmp_path / "note.ts"
    note.write_text(f"见 ADR-0002/0009 与 {ghost}.\n", encoding="utf-8")
    problems = cite_problems([note], {"0002", "0009"})
    assert len(problems) == 1
    assert ghost in problems[0]
    assert "note.ts:1" in problems[0]
