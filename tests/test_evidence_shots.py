"""按钮 PNG 的完整性检查(ADR-0006 决定 2).

PNG 只能从真机截(`page-action.py evidence --shots`);CI 够不着浏览器, 但够得着**已经截下来的
那份**: 签名, IHDR, 宽高, 文件名对应一条存证. 当前页没有的控件(生成中, 代码块, 收起态)
不会有图, 这与真机对账的"未比"同一个口径, 见 `docs/evidence/controls.md`.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "protocol" / "evidence" / "controls.json"
SHOTS = ROOT / "protocol" / "evidence" / "shots"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def entry_ids() -> set[str]:
    data = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    return {entry["id"] for entry in data["entries"]}


def shot_problems(path: Path, ids: set[str]) -> list[str]:
    problems: list[str] = []
    if path.stem not in ids:
        problems.append(f"文件名不是存证 id: {path.stem}")
    raw = path.read_bytes()
    if not raw.startswith(PNG_SIGNATURE):
        problems.append("不是 PNG(签名不对)")
        return problems
    if len(raw) < 24 or raw[12:16] != b"IHDR":
        problems.append("缺 IHDR")
        return problems
    width, height = struct.unpack(">II", raw[16:24])
    if width <= 0 or height <= 0:
        problems.append(f"宽高不是正数: {width}x{height}")
    return problems


def test_every_shot_is_a_png_of_a_known_control() -> None:
    assert SHOTS.is_dir(), "还没有真机截图:跑 page-action.py evidence --shots"
    shots = sorted(SHOTS.glob("*.png"))
    assert shots, "截图目录是空的"
    ids = entry_ids()
    problems = {path.name: shot_problems(path, ids) for path in shots}
    assert {name: found for name, found in problems.items() if found} == {}


def test_shot_check_catches_a_broken_or_misnamed_file(tmp_path: Path) -> None:
    ids = entry_ids()
    truncated = tmp_path / f"{next(iter(ids))}.png"
    truncated.write_bytes(PNG_SIGNATURE)
    assert "缺 IHDR" in shot_problems(truncated, ids)
    empty = tmp_path / "not-a-control.png"
    empty.write_bytes(b"not a png")
    assert shot_problems(empty, ids) == [
        "文件名不是存证 id: not-a-control",
        "不是 PNG(签名不对)",
    ]


@pytest.mark.parametrize("path", sorted(SHOTS.glob("*.png")), ids=lambda path: path.stem)
def test_a_shot_is_not_a_thumbnail_stub(path: Path) -> None:
    """一张正常按钮图至少 8x8; 防止"随便写个 1x1 PNG 占位"混进来."""
    raw = path.read_bytes()
    width, height = struct.unpack(">II", raw[16:24])
    assert width >= 8 and height >= 8
    assert len(raw) > 64
