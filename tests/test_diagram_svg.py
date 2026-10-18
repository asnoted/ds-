"""`dsbcli svg` 的口径: 从 archify 导出的 HTML 抽出 README 那张可内嵌的 SVG.

这条链子跟别的模块不一样的地方是**产物进仓**: `docs/diagrams/continuation-round.svg`
在 README 里当图片挂着, 而它就是这套抽法跑出来的. 于是有两条谁都该守的:

- **留档 == 今天抽一遍的字节**(逐字): 谁手改了那个 SVG, 或者抽法偷偷改了, 这里当场红;
- 抽法自己那几条判据: 选择器作用域那道闸、变量块认哪套预设、叠加时后写的赢、
  顶层规则怎么切(带嵌套的 `@media` 算一条)、没 `<svg>` 时把话说清.

搬家中间态: 模块在 `devtools/dsbcli/tools/` 与 `scripts/` 之间搬, 两种树都得能跑, 所以
`load_extractor` 先按包找, 再按老路径兜底; 搬完把兜底那半删掉.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[1]

LEGACY = ROOT / "scripts" / "extract-diagram-svg.py"

DIAGRAM_HTML = ROOT / "docs" / "diagrams" / "continuation-round.html"
DIAGRAM_SVG = ROOT / "docs" / "diagrams" / "continuation-round.svg"

XMLNS = 'xmlns="http://www.w3.org/2000/svg"'


def load_extractor() -> ModuleType:
    try:
        return importlib.import_module("dsbcli.tools.extract_svg")
    except ModuleNotFoundError:
        if not LEGACY.is_file():
            raise
        spec = importlib.util.spec_from_file_location("extract_svg_legacy", LEGACY)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module


def test_the_committed_diagram_is_exactly_what_the_extractor_produces_today() -> None:
    extractor = load_extractor()
    produced = extractor.build_svg(DIAGRAM_HTML.read_text(encoding="utf-8"), "light")
    assert produced == DIAGRAM_SVG.read_text(encoding="utf-8")


def test_svg_scope_lets_the_svg_scoped_rules_through() -> None:
    extractor = load_extractor()
    assert extractor.svg_scope("svg .c-node")
    assert extractor.svg_scope(":root")
    assert extractor.svg_scope(".t-label")
    assert extractor.svg_scope("/* 分节: 结构 */ .c-node")


def test_svg_scope_keeps_out_rules_that_hang_off_html() -> None:
    extractor = load_extractor()
    assert not extractor.svg_scope("html .diagram-container > svg .c-node")
    assert not extractor.svg_scope(".viewer-panel .t-label")


def test_only_the_classic_preset_and_the_asked_theme_layer_in() -> None:
    extractor = load_extractor()
    assert extractor.selector_matches(":root, html", "light")
    assert extractor.selector_matches('[data-preset="classic"]', "light")
    assert extractor.selector_matches('[data-theme="dark"]', "dark")
    assert extractor.selector_matches('[data-preset="classic"][data-theme="dark"]', "dark")
    assert not extractor.selector_matches('[data-preset="editorial"]', "light")
    assert not extractor.selector_matches('[data-theme="dark"]', "light")
    assert not extractor.selector_matches("", "light")


def test_vars_layer_in_document_order_and_the_last_one_wins() -> None:
    extractor = load_extractor()
    rules = [
        (":root", "--a: 1; --b: 2;"),
        ('[data-theme="dark"]', "--a: 9;"),
        (".c-x", "--c: 3;"),
    ]
    assert extractor.resolve_vars(rules, "light") == "--a: 1; --b: 2; --c: 3;"
    assert extractor.resolve_vars(rules, "dark") == "--a: 9; --b: 2; --c: 3;"


def test_top_level_rules_split_on_braces_and_keep_comments_in_place() -> None:
    extractor = load_extractor()
    assert extractor.parse_rules("/* c */ .a { x: 1 }\n@media (x) { .b { y: 2 } }") == [
        ("/* c */ .a", " x: 1 "),
        ("@media (x)", " .b { y: 2 } "),
    ]


def test_a_diagram_without_an_svg_says_so() -> None:
    extractor = load_extractor()
    with pytest.raises(SystemExit, match="找不到 <svg>"):
        extractor.build_svg("<div>没有图</div>", "light")


def test_a_minimal_diagram_gets_xmlns_a_background_and_only_svg_scoped_rules() -> None:
    extractor = load_extractor()
    out = extractor.build_svg(
        "<style>svg .c-a { fill: red }\n.c-b { stroke: blue }\n"
        ".viewer-panel .t-label { color: red }</style>"
        '<svg viewBox="0 0 10 20"><rect/></svg>',
        "light",
    )
    assert XMLNS in out
    assert 'class="c-bg-rect" x="0" y="0" width="10" height="20"' in out
    assert "svg .c-a { fill: red }" in out
    assert ".c-b" in out
    assert "color: red" not in out


def test_xmlns_is_not_added_twice() -> None:
    extractor = load_extractor()
    out = extractor.build_svg(f"<svg {XMLNS}></svg>", "light")
    assert out.count(XMLNS) == 1


def test_only_archify_keyframes_and_no_font_block_ride_along() -> None:
    extractor = load_extractor()
    out = extractor.build_svg(
        "<style>@keyframes archify-pulse { from { opacity: 0 } }\n"
        "@keyframes spin { to { transform: rotate(1turn) } }\n"
        "@font-face { font-family: x; src: url(y) }</style><svg></svg>",
        "light",
    )
    assert "@keyframes archify-pulse" in out
    assert "@keyframes spin" not in out
    assert "@font-face" not in out


def test_a_var_block_becomes_values_not_a_rule_of_its_own() -> None:
    extractor = load_extractor()
    out = extractor.build_svg(
        "<style>:root { --a: 1 }\n.c-a { fill: var(--a) }</style><svg></svg>",
        "light",
    )
    assert ":root { --a: 1 }" not in out
    assert "--a: 1;" in out
