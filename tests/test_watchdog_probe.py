"""看门狗探针的判据半边: `stop_spans` 划的圆键区间, 与 `Recorder` 记/筛 console 的手法.

这两处都在**真机腿的结论链**上: 闸关着 / 开着那几半都是拿它们读出来的, 而它们错了不会报错,
只会让读数说谎. 两处各带一次真踩过的坑:

- `stop_spans` 的边界取**相邻采样时刻**(粒度 = 采样间隔): 一把把它当成"第一个不带 stop 的
  采样"会把区间拉长一格;
- `Recorder` 必须按时刻筛: `Runtime.enable` 的瞬间 CDP 会把 SW 缓冲的历史 console 整批回放
  (实测一次上千行, 跨数小时), 不筛就会把**上一轮**的催办行当成这一轮的判定 -- 证据链被污染,
  踩过.

`stop("stop" 那个词)` 只在**引号里**才算: 采样的文本是页面报的 JSON 片段, 全词命中会把
正文里出现 stop 的普通文字当成按下.

搬家中间态: 模块在 `devtools/dsbcli/tools/` 与 `scripts/` 之间搬, 两种树都要能跑, 所以
`load_probe` 先按包找再按老路径兜底; 搬完把兜底那半删掉.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]

LEGACY = ROOT / "scripts" / "watchdog-probe.py"


def load_probe() -> ModuleType:
    if "websockets" not in sys.modules:
        try:
            import websockets  # noqa: F401
        except ModuleNotFoundError:
            sys.modules["websockets"] = types.ModuleType("websockets")
    try:
        return importlib.import_module("dsbcli.tools.watchdog_probe")
    except ModuleNotFoundError:
        if not LEGACY.is_file():
            raise
        spec = importlib.util.spec_from_file_location("watchdog_probe_legacy", LEGACY)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module


def recorder(probe: ModuleType):
    """只要记/筛这两件, 不建连接."""
    return probe.Recorder(None)


def console(text: object, timestamp: float) -> dict:
    return {
        "method": "Runtime.consoleAPICalled",
        "params": {"args": [{"value": text}], "timestamp": timestamp},
    }


def test_stop_spans_end_at_the_last_sample_that_saw_the_stop_key() -> None:
    probe = load_probe()
    samples = [
        (0.0, '{"pressed":"send"}'),
        (1.0, '{"pressed":"stop"}'),
        (2.0, '{"pressed":"stop"}'),
        (3.0, '{"pressed":"send"}'),
    ]
    assert probe.stop_spans(samples) == [(1.0, 2.0)]


def test_a_tail_that_is_still_generating_closes_at_the_last_sample() -> None:
    probe = load_probe()
    samples = [(0.0, "a"), (1.0, '"stop"'), (2.0, '"stop"')]
    assert probe.stop_spans(samples) == [(1.0, 2.0)]


def test_two_stop_phases_give_two_spans() -> None:
    probe = load_probe()
    samples = [(0.0, '"stop"'), (1.0, "a"), (2.0, '"stop"'), (3.0, "a")]
    assert probe.stop_spans(samples) == [(0.0, 0.0), (2.0, 2.0)]


def test_the_word_stop_only_counts_inside_quotes() -> None:
    probe = load_probe()
    assert probe.stop_spans([(0.0, "生成中 stop 文字"), (1.0, "还是")]) == []
    assert probe.stop_spans([(0.0, '{"pressed":"stop"}')]) == [(0.0, 0.0)]


def test_no_stop_phase_is_no_span() -> None:
    probe = load_probe()
    assert probe.stop_spans([]) == []
    assert probe.stop_spans([(0.0, "a"), (1.0, "b")]) == []


def test_only_console_lines_with_a_string_are_recorded() -> None:
    probe = load_probe()
    rec = recorder(probe)
    rec._record(console("催办", 1000))
    rec._record(console(7, 1001))
    rec._record(console("", 1002))
    rec._record({"method": "Runtime.consoleAPICalled", "params": {"args": [], "timestamp": 1003}})
    rec._record({"method": "Runtime.executionContextCreated", "params": {}})
    assert rec.lines == ["催办"]


def test_log_entries_are_recorded_too() -> None:
    probe = load_probe()
    rec = recorder(probe)
    entry = {"method": "Log.entryAdded", "params": {"entry": {"text": "日志行", "timestamp": 3}}}
    rec._record(entry)
    rec._record({"method": "Log.entryAdded", "params": {"entry": {"timestamp": 4}}})
    assert rec.lines == ["日志行"]


def test_realtime_lines_drop_the_history_cdp_replays() -> None:
    probe = load_probe()
    rec = recorder(probe)
    rec._record(console("上一轮的催办", 1000))
    rec._record(console("这一轮的催办", 3000))
    assert rec.lines == ["上一轮的催办", "这一轮的催办"]
    assert rec.realtime_lines(1500) == ["这一轮的催办"]
    assert rec.realtime_lines(0) == ["上一轮的催办", "这一轮的催办"]


def test_a_console_line_without_a_timestamp_counts_as_history() -> None:
    probe = load_probe()
    rec = recorder(probe)
    rec._record(console("没有时刻", 0))
    assert rec.realtime_lines(1) == []
