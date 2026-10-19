"""改名迁移得有人调: 函数写得再对, 接线掉了就是死代码.

`src/lib/migrate.test.ts` 把 `planStorageMigration` 的每一步都钉住了, 但不管
`entrypoints/background.ts` 有没有真去调. 把顶层那句删掉, 全量 TS 套件照绿 --
现场是升级后旧键永远躺在 `storage.local` 里, 失败痕 / 等人回 / 看门狗配置断代.

两条接线各管一段时间:

- **顶层**: service worker 每次醒来都跑, 且必须在 `syncFromStorage` **之前** --
  先搬完再读, 否则这一拍读到的仍是"旧键缺席"的空状态.
- **`onInstalled`**: 安装 / 升级那一下也跑, 别只指望 SW 恰好在同一拍醒来.

扫源码是这里唯一能碰到接线的地方: 函数在 MV3 入口里, 单测拿不到 `browser`.
"""

from __future__ import annotations

import re
from pathlib import Path

BACKGROUND = Path(__file__).resolve().parents[1] / "entrypoints" / "background.ts"


def source() -> str:
    return BACKGROUND.read_text(encoding="utf-8")


def test_startup_migrates_before_reading_storage() -> None:
    assert re.search(
        r"migrateLegacyStorage\(\)\s*\.then\(\(\)\s*=>\s*syncFromStorage\(\)\)",
        source(),
    ), "顶层得先迁移、再 syncFromStorage: 顺序反了这一拍读到的是旧键缺席的空状态"


def test_on_installed_also_migrates() -> None:
    text = source()
    start = text.find("browser.runtime.onInstalled.addListener(")
    assert start >= 0, "background.ts 里找不到 onInstalled 监听"
    end = text.find("});", start)
    assert end > start, "onInstalled 监听收尾没找到"
    assert "migrateLegacyStorage()" in text[start:end], (
        "安装 / 升级那一下也要搬: 别只指望 service worker 恰好在同一拍醒来"
    )
