"""页面控件存证的完整性对拍(ADR-0018):与 `src/lib/evidence.test.ts` 是同一判据的两份独立实现.

`protocol/evidence/controls.json` 是真机按钮原件(`outerHTML` 一字不缩写 + 完整 `svg path` + 真机
日期).这里用标准库 `html.parser` 把 `svgs` 从 `outerHTML` 里独立解析一遍:缩写,改写,断头 tag
都在这里红;两半对不上也红.'站点 ↔ 存证'的真机对账不在这里(CI 够不着),见
`scripts/page-action.py evidence`.
"""

from __future__ import annotations

import datetime
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import pytest

EVIDENCE = Path(__file__).resolve().parents[1] / "protocol" / "evidence" / "controls.json"
DATE_SHAPE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PLACEHOLDERS = ("...", "...", "<!--")
RECONCILE = {"live", "state-bound"}
VOID_TAGS = frozenset(
    [
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "source",
        "track",
        "wbr",
    ],
)


class SvgCollector(HTMLParser):
    """收每个 `svg` 的 viewBox 与 path 的 d,并记 tag 是否成对."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.svgs: list[dict[str, Any]] = []
        self.stack: list[str] = []
        self.balanced = True
        self._svg_depth: list[int] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "svg":
            self.svgs.append({"viewBox": attributes.get("viewbox"), "paths": []})
            self._svg_depth.append(len(self.stack))
        elif tag == "path" and self.svgs and self._svg_depth:
            self.svgs[-1]["paths"].append(attributes.get("d") or "")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # 自闭合写法:只收内容,不入栈.
        if tag == "path" and self.svgs:
            self.svgs[-1]["paths"].append(dict(attrs).get("d") or "")

    def handle_endtag(self, tag: str) -> None:
        if tag in VOID_TAGS:
            return
        if not self.stack or self.stack[-1] != tag:
            self.balanced = False
            return
        self.stack.pop()
        if tag == "svg" and self._svg_depth and self._svg_depth[-1] == len(self.stack):
            self._svg_depth.pop()


def parse_svgs(html: str) -> tuple[list[dict[str, Any]], bool]:
    collector = SvgCollector()
    collector.feed(html)
    collector.close()
    # 断在 tag 中间时解析器不报错,只当没读到:整段必须以 `>` 收尾才算收全.
    whole = html.startswith("<") and html.endswith(">")
    return collector.svgs, whole and collector.balanced and not collector.stack


def entry_problems(entry: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if not isinstance(entry.get("id"), str) or not entry["id"]:
        problems.append("缺 id")
    captured = entry.get("capturedOn")
    if not isinstance(captured, str) or not DATE_SHAPE.match(captured):
        problems.append("capturedOn 不是 YYYY-MM-DD")
    else:
        try:
            day = datetime.date.fromisoformat(captured)
        except ValueError:
            problems.append("capturedOn 不是真实日期")
        else:
            if day > datetime.date.today() + datetime.timedelta(days=1):
                problems.append("capturedOn 在未来")
    if entry.get("reconcile") not in RECONCILE:
        problems.append("reconcile 只能是 live / state-bound")
    probe = entry.get("probe")
    if not isinstance(probe, str) or not probe.strip():
        problems.append("缺 probe")
    row = entry.get("row")
    if row is not None:
        complete = (
            isinstance(row, dict)
            and isinstance(row.get("container"), str)
            and bool(row["container"])
            and isinstance(row.get("siblings"), int)
            and isinstance(row.get("index"), int)
            and isinstance(row.get("anchor"), str)
            and bool(row["anchor"])
        )
        if not complete:
            problems.append("row 不完整(container / siblings / index / anchor)")
    html = entry.get("outerHTML")
    if not isinstance(html, str) or not html:
        problems.append("缺 outerHTML")
        return problems
    problems.extend(f"outerHTML 含占位 {m}" for m in PLACEHOLDERS if m in html)
    svgs, balanced = parse_svgs(html)
    if not balanced:
        problems.append("outerHTML 的 tag 不成对(断头 / 被缩写)")
    if svgs != entry.get("svgs"):
        problems.append("svgs 与 outerHTML 里解析出的 svg 不一致")
    return problems


def load_entries() -> list[dict[str, Any]]:
    if not EVIDENCE.is_file():
        raise FileNotFoundError("存证文件缺失:protocol/evidence/controls.json")
    data = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    assert isinstance(data["description"], str)
    assert data["description"]
    entries = data["entries"]
    assert isinstance(entries, list)
    assert entries
    return entries


def test_ids_are_unique() -> None:
    ids = [entry["id"] for entry in load_entries()]
    assert len(set(ids)) == len(ids)


@pytest.mark.parametrize("entry", load_entries(), ids=lambda entry: entry["id"])
def test_every_entry_is_complete(entry: dict[str, Any]) -> None:
    assert entry_problems(entry) == []


def sample() -> dict[str, Any]:
    for entry in load_entries():
        if any(svg["paths"] for svg in entry["svgs"]):
            return json.loads(json.dumps(entry))
    raise AssertionError("存证里没有带 svg path 的条目,没法造坏样本")


def test_missing_captured_on_is_caught() -> None:
    bad = sample()
    bad["capturedOn"] = ""
    assert "capturedOn 不是 YYYY-MM-DD" in entry_problems(bad)


def test_dropped_path_is_caught() -> None:
    bad = sample()
    bad["svgs"][0]["paths"] = bad["svgs"][0]["paths"][:-1]
    assert "svgs 与 outerHTML 里解析出的 svg 不一致" in entry_problems(bad)


def test_edited_path_is_caught() -> None:
    bad = sample()
    bad["svgs"][0]["paths"][0] += "0"
    assert "svgs 与 outerHTML 里解析出的 svg 不一致" in entry_problems(bad)


def test_abbreviated_html_is_caught() -> None:
    good = sample()
    ellipsis = {**good, "outerHTML": good["outerHTML"][:40] + "..."}
    assert entry_problems(ellipsis)
    truncated = {**good, "outerHTML": good["outerHTML"][:60]}
    assert "outerHTML 的 tag 不成对(断头 / 被缩写)" in entry_problems(truncated)
