"""对拍: `measure-result-forms.py` 拆命中与三种形态的口径.

口径是这条测量链的全部--拆错一行、少一个键名,数字就偏,而 ADR-0025 拿它当"不建结构化
通路"的论据.所以三样都钉住: 拆回三列(脚注丢掉)、三种形态逐字、以及拆出来的 `today`
就是 `grep_tree` 真的交出来的那一串(往返一致).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "measure-result-forms.py"


def load_measure() -> ModuleType:
    spec = importlib.util.spec_from_file_location("measure_result_forms_under_test", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HITS = [
    ("src/lib/run.ts", 142, "function onResult(state: RunState, payload: ReplyPayload)"),
    ("README.md", 7, "ds-: 浏览器扩展 + 本机 MCP 中继"),
]


def test_parse_hits_splits_three_columns_and_drops_footnotes() -> None:
    module = load_measure()
    text = "\n".join(
        [
            "src/lib/run.ts:142: function onResult(state: RunState, payload: ReplyPayload)",
            "README.md:7: ds-: 浏览器扩展 + 本机 MCP 中继",
            "...(命中数达上限 200,已截断)",
            "(结果已截断:原文 16000 字,这里是前 16000 字;收窄模式,或指定 path 分几次搜)",
        ]
    )
    assert module.parse_hits(text) == HITS


def test_the_three_forms_are_pinned() -> None:
    """形态逐字钉住: 比较的就是这三串."""

    module = load_measure()
    assert module.form_today(HITS) == (
        "src/lib/run.ts:142: function onResult(state: RunState, payload: ReplyPayload)\n"
        "README.md:7: ds-: 浏览器扩展 + 本机 MCP 中继"
    )
    assert module.form_structured(HITS) == (
        '[{"path":"src/lib/run.ts","number":142,'
        '"text":"function onResult(state: RunState, payload: ReplyPayload)"},'
        '{"path":"README.md","number":7,"text":"ds-: 浏览器扩展 + 本机 MCP 中继"}]'
    )
    # 表格形是上界: 表头一行, 一行一条, Tab 分隔, 不转义.
    assert module.form_toon(HITS) == (
        "path\tnumber\ttext\n"
        "src/lib/run.ts\t142\tfunction onResult(state: RunState, payload: ReplyPayload)\n"
        "README.md\t7\tds-: 浏览器扩展 + 本机 MCP 中继"
    )


def test_today_form_round_trips_the_real_grep_output(tmp_path: Path) -> None:
    """往返一致: 拆出来的 `today` 就是 `grep_tree` 真交出来的那一串(脚注除外)."""

    module = load_measure()
    sys_path_added = str(ROOT)
    import sys

    if sys_path_added not in sys.path:
        sys.path.insert(0, sys_path_added)
    from dsb.work import grep_tree

    (tmp_path / "a.ts").write_text("第一行: needle 在这里\n无关\n", encoding="utf-8")
    (tmp_path / "b.ts").write_text("needle 又一处\n", encoding="utf-8")
    text = grep_tree(tmp_path, "needle", ".")
    assert module.form_today(module.parse_hits(text)) == text


def test_a_pattern_with_no_hits_measures_a_placeholder() -> None:
    """无命中时 `grep_tree` 回一句"(无命中)", 不是零条--那也该量得出来."""

    module = load_measure()
    text = module.form_today(module.parse_hits("(无命中)"))
    assert text == ""


def test_render_reports_chars_without_a_tokenizer() -> None:
    module = load_measure()
    report = module.render(HITS, None)
    assert report["hits"] == 2
    assert set(report["forms"]) == {"today", "structured", "toon"}
    assert report["forms"]["today"]["chars"] == len(module.form_today(HITS))
    assert "tokens" not in report["forms"]["today"]


def test_cli_grep_json_parses() -> None:
    """命令行那一层也要钉: `--json` 挂错 parser 就会当场报错(它已经咬过一次)."""

    import json
    import subprocess
    import sys

    finished = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "grep",
            "--pattern",
            "WorkError",
            "--path",
            "dsb",
            "--json",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=True,
    )
    report = json.loads(finished.stdout)
    assert report["patterns"][0]["pattern"] == "WorkError"
    assert report["patterns"][0]["hits"] > 0
    assert set(report["totals"]) == {"today", "structured", "toon"}
    assert report["totals"]["today"]["chars"] > 0
