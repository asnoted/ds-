"""扩展与开发期探针共用的那几个字面量:两边各写各的,漂了谁也不红.

探针靠这些名字捅进扩展内部:`storage.local` 的键,与页面世界信封上的两个标记
(`ds-/action` / `ds-/chain`).探针那边几个常量的注释已经写着"与 `src/lib/...`
同一份" -- 但这句注释没人管:改一边,另一边静默地对不上,探针读不到键,它报出来的
绿红就都是假的(看门狗那条腿尤其:静默窗口设在一把没人读的键上,催办永远不触发).

**扩展是真源**:`src/lib/*.ts` 的 `export const` 从源码里读出来,与探针的常量逐对拍.
看门狗探针那边没有常量(直接往 JS 片段里塞字面量),所以按源码里的引号形式对拍.
"""

from __future__ import annotations

import re
from pathlib import Path

from conftest import load_page_action

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "src" / "lib"

#: 探针里的常量 → 扩展那份真源(文件名, 导出名).
SHARED = (
    ("ACTION_MESSAGE_TYPE", "channel.ts", "ACTION_MESSAGE_TYPE"),
    ("CHAIN_MESSAGE_SOURCE", "channel.ts", "CHAIN_MESSAGE_SOURCE"),
    ("FAILURE_LOG_KEY", "failurelog.ts", "FAILURE_LOG_STORAGE_KEY"),
    ("FAILURE_FRAME_KEY", "failureframe.ts", "FAILURE_FRAME_STORAGE_KEY"),
    ("TOGGLE_KEY", "toggle.ts", "TOGGLE_STORAGE_KEY"),
    ("SPEAK_KEY", "toggle.ts", "SPEAK_STORAGE_KEY"),
)


def ts_string(filename: str, name: str) -> str:
    """`export const NAME = "...";` 里的字面量.找不到就让用例红在断言上,不是 import 上."""
    match = re.search(
        rf'^export const {name} = "([^"]+)";$',
        (LIB / filename).read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert match is not None, f"src/lib/{filename} 里没找到 {name}"
    return match.group(1)


def probe_source(stem: str) -> str:
    """探针本体的源码:先按包找,再按搬家前的老路径兜底(两种树都要跑得起来)."""
    candidates = (
        ROOT / "dsbcli" / "tools" / f"{stem}.py",
        # 第二条是 2026-10 大搬家前的老路径:搬迁落地后删掉.
        ROOT / "scripts" / f"{stem.replace('_', '-')}.py",
    )
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise AssertionError("找不到探针源码:" + " / ".join(str(path) for path in candidates))


def test_page_action_shares_the_extension_names() -> None:
    probe = load_page_action()
    for probe_name, filename, ts_name in SHARED:
        assert getattr(probe, probe_name) == ts_string(filename, ts_name), probe_name


def test_watchdog_probe_uses_the_extension_names() -> None:
    source = probe_source("watchdog_probe")
    for filename, ts_name in (
        ("watchdog.ts", "WATCHDOG_CONFIG_STORAGE_KEY"),
        ("channel.ts", "CHAIN_MESSAGE_SOURCE"),
        ("channel.ts", "ACTION_MESSAGE_TYPE"),
    ):
        value = ts_string(filename, ts_name)
        assert f"'{value}'" in source, f"看门狗探针里没找到 '{value}'"
