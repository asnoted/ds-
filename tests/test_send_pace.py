"""唯一限速的探针半边(ADR-0029):`scripts/page-action.py` 的抽样与共享规格对拍.

与 `src/lib/outbound.test.ts` 是同一判据的两份独立实现:规格改了而哪半没跟上,
两半都在这里红.
"""

from __future__ import annotations

import random
from typing import Any

from conftest import load_fixture, load_page_action

SPEC: dict[str, Any] = load_fixture("send-pace.json")


def test_spec_numbers_pinned() -> None:
    assert (SPEC["minMs"], SPEC["modeMs"], SPEC["maxMs"]) == (3000, 6000, 15000)
    assert (SPEC["sampleSize"], SPEC["sampleRank"]) == (5, 2)


def test_mode_falls_at_the_only_peak() -> None:
    """次序统计量 Beta(rank, size+1-rank) 的众数落回区间必须是 modeMs."""
    mode_ratio = (SPEC["sampleRank"] - 1) / (SPEC["sampleSize"] - 1)
    assert SPEC["minMs"] + mode_ratio * (SPEC["maxMs"] - SPEC["minMs"]) == SPEC["modeMs"]


def test_fixed_source_cases_from_the_fixture() -> None:
    page_action = load_page_action()
    for case in SPEC["cases"]:
        unit = float(case["u"])
        got = page_action.draw_window_interval(SPEC, rng=lambda unit=unit: unit)
        assert got == case["expectedMs"], case["name"]


def test_non_finite_falls_back_to_the_min_interval() -> None:
    page_action = load_page_action()
    for bad in (float("nan"), float("inf")):
        assert page_action.draw_window_interval(SPEC, rng=lambda bad=bad: bad) == SPEC["minMs"]


def test_seeded_draws_stay_in_range_and_centered() -> None:
    page_action = load_page_action()
    rng = random.Random(20261015).random
    draws = [page_action.draw_window_interval(SPEC, rng=rng) for _ in range(2000)]
    assert all(SPEC["minMs"] <= one <= SPEC["maxMs"] for one in draws)
    assert 6500 <= sum(draws) / len(draws) <= 7500
