"""扩展与中继之间的暗号:两半各写各的,漂了谁也不红.

扩展在 `src/lib/relay.ts` 里写死落点、端点与调用超时,中继在 `dsb/` 里写死监听落点、端点与
工具超时.这三条关系都是**跨语言**的--各自的单测只能证明"自己没变":只漂一边,既有测试全绿,
现场是扩展连不上,或者白扔一次正在跑的调用.

- 落点: `RELAY_ORIGIN` 的主机与端口 == `DEFAULT_HOST` / `DEFAULT_PORT`;
- 端点: `relay.ts` 的 `MCP_PATH` == `dsb/mcp.py` 的 `MCP_PATH`(一边 404, 一边连不上);
- 超时: 扩展的 `MCP_CALL_TIMEOUT_MS` / `MCP_LIST_TIMEOUT_MS` 必须**宽于**中继对应的最坏
  路径(调用是"重起 + 工具"两段, 表是"起 + 发现")--先回来的必须是中继, 它回的
  `tool-timeout` 有信息量; 扩展先 abort 只剩没信息量的"中继不可达".

`.env` 正文与端口解析归 `tests/test_server_env.py`.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

from dsb.gateway import DEFAULT_TOOL_TIMEOUT, DISCOVERY_TIMEOUT, START_TIMEOUT
from dsb.mcp import MCP_PATH
from dsb.server import DEFAULT_HOST, DEFAULT_PORT

RELAY_TS = Path(__file__).resolve().parents[1] / "src" / "lib" / "relay.ts"


def ts_string(name: str) -> str:
    """`export const NAME = "...";` 里的字面量.找不到就让用例红在断言上, 不是 import 上."""
    match = re.search(
        rf'^export const {name} = "([^"]+)";$', RELAY_TS.read_text(encoding="utf-8"), re.MULTILINE
    )
    assert match is not None, f"src/lib/relay.ts 里没找到 {name}"
    return match.group(1)


def ts_number(name: str) -> float:
    match = re.search(
        rf"^export const {name} = ([0-9][0-9_]*);$",
        RELAY_TS.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert match is not None, f"src/lib/relay.ts 里没找到 {name}"
    return float(match.group(1).replace("_", ""))


def test_the_endpoint_host_and_port_match_the_relay_defaults() -> None:
    """扩展按 `127.0.0.1:8787` 连, 中继按 `DEFAULT_HOST`:`DEFAULT_PORT` 听."""
    parts = urlsplit(ts_string("RELAY_ORIGIN"))
    assert (parts.hostname, parts.port) == (DEFAULT_HOST, DEFAULT_PORT)


def test_the_endpoint_path_matches_on_both_halves() -> None:
    assert ts_string("MCP_PATH") == MCP_PATH


def test_the_extension_waits_longer_than_the_relay_can_ever_take() -> None:
    """先 abort 的必须是中继: 扩展那边的超时只管"中继是不是彻底不在了".

    两条腿都按中继的**最坏路径**算, 不是按单段:

    - 调用: 子进程死了先重起一次(`START_TIMEOUT` 那笔握手), 再等工具;
    - 工具表: 空表现拉一次(`DISCOVERY_TIMEOUT` 那笔)--这条路今天不重起子进程,
      这里把起那一段也算进去, 松一档换"扩展永远不会抢在中继前面".

    改中继的任一段, 这条就红: 130s 那版漏的正是重起那 30s.
    """
    assert ts_number("MCP_CALL_TIMEOUT_MS") > (START_TIMEOUT + DEFAULT_TOOL_TIMEOUT) * 1000
    assert ts_number("MCP_LIST_TIMEOUT_MS") > (START_TIMEOUT + DISCOVERY_TIMEOUT) * 1000
