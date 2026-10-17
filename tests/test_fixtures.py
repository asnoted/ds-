"""共享 fixture 的完整性与两半对拍:改一边必须在这里或 vitest 那边被发现."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import load_fixture, load_fixture_filenames

from dsb import work

EXPECTED_FILES = [
    "action.json",
    "config.json",
    "fence.json",
    "read.json",
    "reply.json",
    "result-units.json",
    "send-pace.json",
]
REPLY_ANCHOR = "agent:"


def raw_cases(filename: str) -> list[dict[str, Any]]:
    cases = load_fixture(filename)["cases"]
    assert isinstance(cases, list)
    for case in cases:
        assert isinstance(case, dict), f"{filename} 的 case 不是对象:{case!r}"
    return cases


def assert_reply_payload(payload: Any) -> None:
    """载荷必须是 status + answer / error 的同构形状(spec #9)."""
    assert isinstance(payload, dict)
    assert payload.get("status") in {"ok", "error"}
    if payload["status"] == "ok":
        assert isinstance(payload.get("answer"), str)
        assert "error" not in payload
    else:
        assert isinstance(payload.get("error"), str)
        assert "answer" not in payload


def footnote_of(rendered: str) -> str:
    return rendered.split("\n")[-1]


def fill_footnote(template: str, values: dict[str, str]) -> str:
    """模板填上这一页自己的数(长的先换:{end + 1} 里含着 {end}).

    填法独立于 dsb 的实现(dsb 那边是 f-string,不是查这张表)--任何一边改了就在这里红.
    """
    for key in sorted(values, key=len, reverse=True):
        template = template.replace("{" + key + "}", values[key])
    return template


def test_every_fixture_file_is_present() -> None:
    assert load_fixture_filenames() == EXPECTED_FILES


def test_each_fixture_has_a_description_and_cases() -> None:
    for filename in EXPECTED_FILES:
        fixture = load_fixture(filename)
        assert isinstance(fixture["description"], str)
        assert fixture["description"], filename
        assert fixture["cases"], filename


def test_case_names_are_unique_within_each_file() -> None:
    for filename in EXPECTED_FILES:
        names = [case["name"] for case in raw_cases(filename)]
        assert all(isinstance(name, str) and name for name in names)
        assert len(set(names)) == len(names), filename


def test_send_pace_spec_is_coherent() -> None:
    """唯一限速的规格自洽:众数在区间 (rank-1)/(size-1) 处,case 的期望间隔就是线性映射."""
    spec = load_fixture("send-pace.json")
    mode_ratio = (spec["sampleRank"] - 1) / (spec["sampleSize"] - 1)
    assert spec["minMs"] + mode_ratio * (spec["maxMs"] - spec["minMs"]) == spec["modeMs"]
    for case in raw_cases("send-pace.json"):
        ratio = min(max(case["u"], 0.0), 1.0)
        assert spec["minMs"] + ratio * (spec["maxMs"] - spec["minMs"]) == case["expectedMs"], case[
            "name"
        ]


def test_fence_cases_are_coherent() -> None:
    """抽出围栏正文的输入里必须排着 send 围栏;抽出几块就得有几个起始行.

    一次回答可以排多块(按顺序全取),所以这里是**数组**:几块就是几条.
    """
    for case in raw_cases("fence.json"):
        assert isinstance(case["input"], str)
        calls = case["expectedCalls"]
        assert isinstance(calls, list), case["name"]
        assert all(isinstance(call, str) and call for call in calls), case["name"]
        if calls:
            assert "```send" in case["input"], case["name"]
        openings = [line.strip() for line in case["input"].split("\n")]
        assert openings.count("```send") >= len(calls), case["name"]


def test_reply_payloads_follow_the_schema() -> None:
    for case in raw_cases("reply.json"):
        assert_reply_payload(case["payload"])


def test_reply_message_starts_with_the_anchor() -> None:
    for case in raw_cases("reply.json"):
        lines = case["expectedMessage"].split("\n")
        assert lines[0] == REPLY_ANCHOR, case["name"]
        assert "status:" in "\n".join(lines[1:]), case["name"]


def test_reply_message_has_no_newline_escapes() -> None:
    """解码方是网页上的 LLM,不是解析器,字面反斜杠 n 它不会还原(真机翻车过)."""
    for case in raw_cases("reply.json"):
        assert "\\n" not in case["expectedMessage"], case["name"]


def test_config_cases_cover_known_kinds() -> None:
    for case in raw_cases("config.json"):
        assert case["kind"] in {"value"}
        assert isinstance(case["input"], str)
        assert isinstance(case["key"], str)
        assert isinstance(case["expected"], dict)


def test_action_error_codes_are_unique() -> None:
    """动作失败码册子:code 不重样,when 非空(页面动作的执行器还活着--出站与看门狗用它)."""
    codes = load_fixture("action.json")["errorCodes"]
    assert isinstance(codes, list) and codes
    names = [entry["code"] for entry in codes]
    assert all(isinstance(name, str) and name for name in names)
    assert len(set(names)) == len(names)
    assert all(isinstance(entry["when"], str) and entry["when"] for entry in codes)


def test_action_cases_are_coherent() -> None:
    """每个 case:请求体三条字段在场,响应回 {ok,result} / {ok,error} 两条同构形状
    (与 vitest 那半对拍;扩展不再回显 action--那曾是 relay 回传端点的账面)."""
    error_codes = [entry["code"] for entry in load_fixture("action.json")["errorCodes"]]
    for case in raw_cases("action.json"):
        request, response = case["request"], case["response"]
        assert isinstance(request["action"], str) and request["action"]
        assert isinstance(request["params"], dict)
        assert request["target"] is None or isinstance(request["target"], str)
        assert isinstance(response["ok"], bool)
        if response["ok"]:
            assert "error" not in response, case["name"]
            assert "result" in response, case["name"]
        else:
            assert response["error"] in error_codes, case["name"]
            assert "result" not in response, case["name"]


def read_cases() -> list[dict[str, Any]]:
    return raw_cases("read.json")


def test_read_limits_match_dsb_constants() -> None:
    """「一页 read 的结果能原样进对话」的两个数:dsb 产出那半与 fixture 相等.

    扩展那半(MAX_RESULT_CHARS 与教模型的脚注)在 vitest 独立对着同一份断言(ADR-0010).
    """
    fixture = load_fixture("read.json")
    assert fixture["readPageLines"] == work.WORK_READ_PAGE_LINES
    assert fixture["readPageBudget"] == work.WORK_READ_BYTES


def test_result_units_match_the_extension_measure() -> None:
    """同一个串在 dsb 侧量出来多长,必须与扩展侧量出来的一样(ADR-0010).

    扩展侧那半在 vitest 对着同一份 fixture 用 JS 的 ``.length`` 量;这边用
    :func:`dsb.work._units`.两处对不上,星平面字那条路上"原样进对话"就破口.
    """
    for case in raw_cases("result-units.json"):
        text = case["text"]
        assert work._units(text) == case["utf16Units"], case["name"]
        # 码点是另一种单位,两边也各记着--它是 UTF-16 单元与它分岔的原因.
        assert len(text) == case["codePoints"], case["name"]


def test_read_footnote_cases_are_the_three_states() -> None:
    """三态册子:只有真有下一读的两种才带 ``offset=``(这是脚注的核心判据)."""
    footnotes = {case["name"]: case["template"] for case in read_cases()}
    assert set(footnotes) == {"文件读完", "还有下一页", "字节预算截断"}
    assert "offset" not in footnotes["文件读完"]
    for name in ("还有下一页", "字节预算截断"):
        assert "offset=" in footnotes[name], name


def test_read_footnote_templates_match_dsb_rendering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """三态各渲染一页,末行必须是 fixture 模板填上这一页的数(改任一边就红)."""
    footnotes = {case["name"]: case["template"] for case in read_cases()}

    done = work.render_page(["a", "b", "c"], 1, 3)
    assert footnote_of(done) == fill_footnote(footnotes["文件读完"], {"total": "3"})

    more = work.render_page(["a", "b", "c", "d", "e"], 1, 2)
    assert footnote_of(more) == fill_footnote(
        footnotes["还有下一页"],
        {"start": "1", "end": "2", "end + 1": "3", "total": "5"},
    )

    monkeypatch.setattr("dsb.work.WORK_READ_BYTES", 20)
    capped = work.render_page(["a" * 8, "b" * 8], 1, 5)
    assert footnote_of(capped) == fill_footnote(
        footnotes["字节预算截断"],
        {"start": "1", "end": "1", "end + 1": "2", "total": "2"},
    )
