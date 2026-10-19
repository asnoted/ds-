"""探针自己的失败姿态:对端不回包要收手,没验到东西不许退出 0.

两条都是真机上踩得出来的"没输出的死进程"与"假绿":`evaluate` 早就有超时,
`call_cdp` 却一直裸等;`stop-test` 在闸关着(默认)时两条腿一条都没跑,却退 0.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest
from conftest import load_page_action


class _SilentSocket:
    """永不回包的 CDP 对端:真机上主线程卡住时就是这样."""

    async def __aenter__(self) -> _SilentSocket:
        return self

    async def __aexit__(self, *_exc: object) -> bool:
        return False

    async def send(self, _payload: str) -> None:
        return None

    async def recv(self) -> str:
        await asyncio.sleep(60)
        return ""


def test_cdp_gives_up_when_the_peer_never_answers(monkeypatch, capsys) -> None:
    page_action = load_page_action()
    monkeypatch.setattr(
        page_action.websockets, "connect", lambda *_a, **_k: _SilentSocket(), raising=False
    )
    with pytest.raises(SystemExit) as done:
        page_action.cdp("ws://127.0.0.1:1/x", "Accessibility.getFullAXTree", timeout=0.01)
    assert done.value.code == 4
    assert "等回包超过" in capsys.readouterr().err


def test_stop_test_exit_code_is_not_green_when_nothing_was_verified() -> None:
    page_action = load_page_action()
    assert page_action.stop_test_exit_code({"started": True, "stopped": True}) == 0
    assert page_action.stop_test_exit_code({"started": True, "stopped": False}) == 1
    assert page_action.stop_test_exit_code({"started": False}) == 1
    blocked = {"started": False, "enter": {"ok": False, "error": "disabled"}}
    assert page_action.stop_test_exit_code(blocked) == 4
    # 退出码得真接在命令上(那半要 CDP,测试跑不到 main 的这条路).
    assert "stop_test_exit_code(report)" in inspect.getsource(page_action.main)
