"""对拍: `third-party-mcp-probe.py` 里那些不吃网络的纯件(命令行拼法、进程表、孤儿判定).

真机那半(npx 下载、卡死、重起)进不了 CI, 所以这一条的用处在于: 那半跑出来的判据靠这几件
算, 算错了整条腿就是瞎的. 孤儿判定尤其 -- 2026-10-18 揪出的"只杀壳、孙子留着"就是按
"命令行带着临时根、却不是中继后代"认出来的.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "third-party-mcp-probe.py"


def load_probe() -> ModuleType:
    spec = importlib.util.spec_from_file_location("third_party_mcp_probe_under_test", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def options(command: str | None = None, append_root: bool = False) -> argparse.Namespace:
    return argparse.Namespace(command=command, append_root=append_root)


def test_config_text_is_the_shape_the_gateway_reads() -> None:
    module = load_probe()
    text = module.config_text(["npx", "-y", "some-server", "/tmp/x"])
    body = json.loads(text)
    assert body == {"mcpServers": {"probe": {"command": ["npx", "-y", "some-server", "/tmp/x"]}}}
    assert text.endswith("\n")


def test_default_command_gets_the_temp_root_appended() -> None:
    module = load_probe()
    root = Path("/tmp/某个根")
    got = module.command_of(options(), root)
    assert got == [*module.DEFAULT_COMMAND, "/tmp/某个根"]


def test_a_hand_written_command_only_gets_the_root_where_it_asks_for_it() -> None:
    module = load_probe()
    root = Path("/tmp/某个根")
    assert module.command_of(options('["npx", "-y", "s", "<根>"]'), root) == [
        "npx",
        "-y",
        "s",
        "/tmp/某个根",
    ]
    assert module.command_of(options('["npx", "-y", "s"]'), root) == ["npx", "-y", "s"]
    assert module.command_of(options('["npx", "-y", "s"]', append_root=True), root) == [
        "npx",
        "-y",
        "s",
        "/tmp/某个根",
    ]


def test_parse_ps_keeps_real_rows_and_drops_junk() -> None:
    module = load_probe()
    text = (
        "  101     1 /sbin/launchd\n"
        "  220   101 node /tmp/x/mcp-server 某个根\n"
        "\n"
        "  not-a-pid  1 whatever\n"
        "  330   220 推不动\n"
    )
    table = module.parse_ps(text)
    assert table[101] == (1, "/sbin/launchd")
    assert table[220] == (101, "node /tmp/x/mcp-server 某个根")
    assert table[330] == (220, "推不动")
    assert set(table) == {101, 220, 330}


def test_descendants_walks_the_whole_tree() -> None:
    module = load_probe()
    table = module.parse_ps("10 1 中继\n20 10 壳\n30 20 真身\n40 1 别人家的\n")
    assert module.descendants(table, 10) == {20, 30}
    assert module.descendants(table, 30) == set()


def test_a_child_that_kept_its_father_is_not_a_stray_but_an_orphan_is() -> None:
    """一边是正常的三人链, 一边是 2026-10-18 真机上那一个(父进程是 1).

    判据就是命令行里那句临时根: 它够独特, 不会把别人家的 `node` 算进来.
    """
    module = load_probe()
    table = module.parse_ps(
        "10 1 中继 /tmp/某个根\n"
        "20 10 npm exec -- /tmp/某个根\n"
        "30 20 node /x/mcp-server-filesystem /tmp/某个根\n"
        "40 1 node /x/mcp-server-filesystem /tmp/某个根\n"
        "50 1 node /x/别的-server /tmp/别家的根\n"
    )
    got = module.strays(table, "/tmp/某个根", 10)
    assert [pid for pid, _cmd in got] == [40]
