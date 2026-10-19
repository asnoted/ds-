"""`evidence` 对账那条判据的纯半边(ADR-0006).

真机对账(`dsbcli page evidence`)把每条存证的 probe 在页面上读一遍, 再由 `reconcile_entry`
判"一致 / 过时 / 未比". 判据写错的代价是**两头都错**: 站点真的改版会被说成"未比"放过去,
页面只是没换到那一页又会被报成"过时", 满屏误报 -- 后者一起来, 人就不看了.

存证文件本身的完整性在 `tests/test_evidence.py` 里核; 这里钉的是**判据**: 三种出口各认什么,
拿纯函数对拍(真机那半要 CDP, 在这里够不着).
"""

from __future__ import annotations

from typing import Any

from conftest import load_page_action


def entry(html: str, *, reconcile: str = "live") -> dict[str, Any]:
    return {"id": "x", "reconcile": reconcile, "outerHTML": html}


def test_same_html_is_a_match() -> None:
    page_action = load_page_action()
    verdict, detail = page_action.reconcile_entry(entry("<div></div>"), "<div></div>")
    assert verdict == "一致"
    assert detail == ""


def test_different_html_on_a_live_entry_is_stale_and_says_where() -> None:
    """常驻控件逐字不等 = 站点改版: 判"过时", 并说清第几个字符起不同."""
    page_action = load_page_action()
    verdict, detail = page_action.reconcile_entry(
        entry('<div class="a">x</div>'), '<div class="b">x</div>'
    )
    assert verdict == "过时"
    assert "字符" in detail
    assert "存证" in detail and "站点" in detail


def test_state_bound_entry_is_only_uncompared() -> None:
    """只在某个态出现的控件: 当前态不符**不算过时**, 不然每次换页都满屏误报."""
    page_action = load_page_action()
    verdict, detail = page_action.reconcile_entry(
        entry("<div></div>", reconcile="state-bound"), "<span></span>"
    )
    assert verdict == "未比"
    assert "态" in detail


def test_missing_control_is_uncompared_not_stale() -> None:
    """probe 读不到(`null` 或别的非字符串)只报"未比": 这一页可能根本没有那颗控件."""
    page_action = load_page_action()
    for live in (None, 42, ["x"], {"x": 1}):
        verdict, detail = page_action.reconcile_entry(entry("<div></div>"), live)
        assert verdict == "未比", live
        assert detail, live


def test_a_throwing_probe_is_exactly_one_shape_of_uncompared() -> None:
    """probe 自己抛错(`unwrap` 把 CDP 的 `cdp-error` 原样递回来)也归"未比".

    出口只认"一致 / 过时 / 未比"三种, 所以这里钉的是**判定**: 它不能落到"过时"去 -- 那是
    把"我们的表达式坏了"报成"站点改了", 指错方向. 措辞另说(说明该指向 probe 本身).
    """
    page_action = load_page_action()
    live = {"cdp-error": "SyntaxError: Unexpected token ')'", "raw": {}}
    verdict, detail = page_action.reconcile_entry(entry("<div></div>"), live)
    assert verdict == "未比"
    assert detail


def test_a_probe_error_saying_where_it_differed_would_be_a_false_report() -> None:
    """反面: 抛错的那种**不能**带上"第 N 个字符起不同"那串 -- 那串只在真读到 DOM 时才有意义."""
    page_action = load_page_action()
    live: dict[str, Any] = {"cdp-error": "TypeError: x is null", "raw": {}}
    _, detail = page_action.reconcile_entry(entry("<div class='a'>x</div>"), live)
    assert "字符" not in detail
