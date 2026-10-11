"""共享 fixture 的完整性与两半对拍:改一边必须在这里或 vitest 那边被发现."""

from __future__ import annotations

from typing import Any

from conftest import load_fixture, load_fixture_filenames

EXPECTED_FILES = ["action.json", "config.json", "fence.json", "reply.json"]
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
