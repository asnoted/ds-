"""守卫: `docs/adr/` 这份语料的三条不变量 -- 骨架, 引用, 点名的东西.

ADR 是活文档(ADR-0001): 改口径就地改那一篇, 不另开新篇去"修订/取代". 好处是读一篇就够,
代价是**三样东西没有编译器管**:

- **骨架**: 一篇 ADR 少了一个固定节(比如 `## Consequences`), 或者 H1 的编号与文件名对不
  上, 谁都不会红 -- 直到有人按它去复现, 或者按索引点不到那篇.
- **引用**: 全仓引用 `ADR-NNNN` 的地方(注释, 测试标题, fixture 的 `description`, 探针的
  report 字符串)漏改一处, 也没有编译器会红. 2026-10-17 那次重编号(28 篇并 13 篇)就是靠
  人肉 `grep` 扫的, 扫出 6 处悬空 -- 这两条守卫是那次教训的产物. 重编号还留了**第二层**:
  `ADR-NNNN 决定 M` 里的 M 是**篇内下标**, 旧编号下的下标搬过来就指歪了(仓里真有过五处);
  "号指得到、下标指歪了"这条查不出, 但"那一篇里没有第 M 条"查得出.
- **点名的东西**: 篇里反引号点着的路径与标识符(`dsb/work.py`, `cap_result`,
  `MAX_RESULT_CHARS` 这类)是给读者当**指路牌**用的; 代码里改了名、文件挪了家, 牌还在原地
  指着空地 -- 旧语料写着的 `MAX_RESULT_CHARS = 2000` 就是这么来的.

`tests/test_coding_standards_refs.py` 是同一类守卫(引用了 `docs/CODING_STANDARDS.md` 的
节号); 那条既然落在 tests/, 这条也落这里, 于是本地 `pnpm quality` 与 CI 都跑得到.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
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

#: 篇内引用的形态: `ADR-0008 决定 12` / `ADR-0010 第 19 条`. 下标指歪了(号对、位置不对)这条
#: 查不出; 查得出的是"那一篇里没有第 M 条" -- 并决定 / 删决定的时候, 篇外那些下标最容易漏.
DECISION = re.compile(r"ADR-(\d{4})[^0-9\n]{0,12}(?:决定|第)\s*(\d+)\s*条?")

#: 篇里点名的东西(反引号里): 路径 / 标识符 / 常量. 一个常量改了名、一个文件挪了家, 篇里那句
#: 话就让读者"按它去翻会翻空" -- 这正是这份语料重写前的病(旧篇写着 `MAX_RESULT_CHARS = 2000`).
BACKTICK = re.compile(r"`([^`\n]+)`")
#: 路径: 带斜杠的, 或带代码 / 文档后缀的. 有空格的一律不算(那是命令, 命令由 `## 判据` 那套跑).
PATHISH = re.compile(r"^[\w.-]+(?:/[\w.-]+)+$|^[\w.-]+\.(?:py|ts|json|md|sh|yaml|yml|toml)$")
#: 标识符: 全大写常量 / snake_case / camelCase.
NAMEISH = re.compile(r"^(?:[A-Z][A-Z0-9_]{3,}|[a-z_][a-z0-9_]{3,}|[a-z][a-z0-9]*[A-Z]\w*)$")
#: 编号本身交给上面那两道守卫, 别在这里重复报.
CITATIONISH = re.compile(r"^ADR|^\d")

#: 点名了、但本来就不在仓里的东西: 站点 / 上游 / 协议 / 用户本机. 每条都写清为什么 --
#: 新遇到一条, 先问"是篇里写错了, 还是它真在仓外", 后者才往这里加.
NOT_IN_REPO = {
    "NNNN-kebab-title.md": "骨架模板里的占位文件名(ADR-0001 决定 2)",
    "docs/adr/archive/": "Considered Options 里被否决的那个目录, 故意不存在",
    "mcp.json": "用户本机的配置文件, 仓外; 拒它的是规则, 不是这个文件",
    "tools/call": "MCP 协议的方法名",
    "tools/list": "MCP 协议的方法名",
    "/api/v0/chat/continue": "站点端点",
    "deepseek-ai/DeepSeek-V3": "上游模型仓",
    "ds-/failure-frames": "`storage.local` 的键名, 不是文件",
    "structuredContent": "MCP 协议字段(ADR-0012 明确不建这条通路)",
    "outputSchema": "MCP 协议字段",
    "__ds_remote_feature_store_model": "站点 localStorage 的键",
    "model_configs": "站点配置里的字段",
    "resume_stream": "站点接口里的开关",
    "sse_auto_resume_timeout": "站点接口里的超时",
    "chrome.debugger": "浏览器 API(Considered Options 里否决的退路)",
}

#: 判"在不在仓里"时跳过的目录: 别人的(`vendor/` / `.agents/`)与生成物.
INDEX_SKIP = frozenset(
    {".git", ".jj", "node_modules", ".venv", "vendor", ".agents", ".output", "dist", "__pycache__"}
)
#: 能当"标识符在仓里"证据的后缀: 只认代码与配置, **不认 `.md`** -- 否则一个名字只要在
#: 别处散文里出现过就过关了.
CODE_SUFFIXES = frozenset({".ts", ".py", ".json", ".yaml", ".yml", ".toml", ".sh"})


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


def decision_numbers(path: Path) -> set[int]:
    """一篇 ADR 的 `## 决定` 里出现过的顶层编号(篇内引用指向的就是它们)."""
    section = path.read_text(encoding="utf-8").split("## 决定", 1)[-1].split("\n## ", 1)[0]
    return {int(m.group(1)) for m in re.finditer(r"^(\d+)\. ", section, re.M)}


def decision_numbers_by_adr() -> dict[str, set[int]]:
    return {path.stem[:4]: decision_numbers(path) for path in adr_files()}


def decision_problems(files: Iterable[Path], known: Mapping[str, set[int]]) -> list[str]:
    """返回"引用的决定号在那一篇里不存在"的清单;空列表 = 都指得到."""
    out: list[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        shown = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()
        for lineno, line in enumerate(text.splitlines(), 1):
            for number, item in DECISION.findall(line):
                items = known.get(number)
                if items and int(item) not in items:
                    out.append(
                        f"ADR-{number} 决定 {item} <- {shown}:{lineno}"
                        f"(那篇的决定号只到 {max(items)})"
                    )
    return out


def repo_index() -> tuple[set[str], str]:
    """(仓里的文件名, 代码正文). 前者判路径, 后者判标识符."""
    names: set[str] = set()
    bodies: list[str] = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or any(part in INDEX_SKIP for part in path.parts):
            continue
        rel = path.relative_to(ROOT)
        names.add(rel.as_posix())
        names.add(path.name)
        if path.suffix in CODE_SUFFIXES:
            bodies.append(path.read_text(encoding="utf-8", errors="ignore"))
    return names, "\n".join(bodies)


def named_problems(adr_dir: Path = ADR_DIR) -> list[str]:
    """返回"篇里点名、仓里却没有"的清单;空列表 = 点名的都在.

    只扫 ADR 的正文: `docs/evidence/` 是**来历**, 里面刻意留着旧名字(改名前的常量就在
    那儿当证据), 拿它当"当前口径"扫是扫错地方.
    """
    names, bodies = repo_index()
    out: list[str] = []
    for path in sorted(adr_dir.glob("*.md")):
        if path.name == "README.md":
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for token in BACKTICK.findall(line):
                if token in NOT_IN_REPO or CITATIONISH.match(token):
                    continue
                where = f"{path.name}:{lineno}"
                if "::" in token:  # pytest 节点号: 文件与测试名都要在
                    rel, _, case = token.partition("::")
                    target = ROOT / rel
                    if not target.exists():
                        out.append(f"{token} <- {where}(仓里没这个文件)")
                    elif case and case not in target.read_text(encoding="utf-8"):
                        out.append(f"{token} <- {where}({rel} 里没这个测试名)")
                    continue
                if PATHISH.match(token):
                    probe = token if "*" not in token else token.rsplit("/", 1)[0]
                    if probe in names or ROOT.joinpath(probe).exists():
                        continue
                    out.append(f"{token} <- {where}(仓里没这个路径)")
                elif NAMEISH.match(token) and token not in bodies:
                    out.append(f"{token} <- {where}(代码里没这个名字)")
    return out


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


def test_every_decision_citation_lands() -> None:
    problems = decision_problems(scanned_files(), decision_numbers_by_adr())
    assert not problems, (
        "引用的决定号在那一篇里不存在(并决定 / 删决定时, 篇外那些下标要一起改):\n"
        + "\n".join(problems)
    )


def test_every_named_thing_exists() -> None:
    problems = named_problems()
    assert not problems, (
        "ADR 里点名的路径 / 标识符在仓里找不到(改了名 / 挪了家就把篇里那句一起改; "
        "真在仓外的往 NOT_IN_REPO 里加并写清理由):\n" + "\n".join(problems)
    )


def test_named_check_fires(tmp_path: Path) -> None:
    """三个面各打一枪: 路径 / 标识符 / pytest 节点号("文件在, 测试名没了")."""
    bad_name = "cap_result" + "x"  # 拼出来: 不然这条守卫自己的源码里就"有"这个名字了
    bad_path = "src/lib/" + "nope.ts"
    bad_case = "test_nope_" + "does_not_exist"
    note = tmp_path / "note.md"
    note.write_text(
        f"见 `{bad_path}` 与 `{bad_name}`; 判据是 "
        f"`tests/test_gateway.py::{bad_case}`; 对照 `dsb/work.py` 与 `cap_result`.\n",
        encoding="utf-8",
    )
    problems = named_problems(tmp_path)
    assert len(problems) == 3, problems
    joined = "\n".join(problems)
    assert bad_path in joined
    assert bad_name in joined
    assert bad_case in joined


def test_decision_check_fires(tmp_path: Path) -> None:
    note = tmp_path / "note.md"
    note.write_text(
        "见 ADR-0002 决定 9 与 ADR-0002 第 2 条, 还有 ADR-0003 决定 1.\n", encoding="utf-8"
    )
    problems = decision_problems([note], {"0002": {1, 2}, "0003": {1}})
    assert len(problems) == 1
    assert "ADR-0002 决定 9" in problems[0]
    assert "note.md:1" in problems[0]


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
