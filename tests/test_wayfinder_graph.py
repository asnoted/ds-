"""依赖图必须和 `docs/wayfinder/nodes.csv` / `edges.csv` 一致.

图是生成物, CSV 是源. 手改图里的箭头或动作标记, 下次生成就被覆盖; 改 CSV 忘了生成,
读的人会看到旧图. 这条只做一件事: 拿 `--check` 跑一遍, 有出入就红.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "wayfinder-graph.py"
pytestmark = pytest.mark.docs


def test_wayfinder_graph_is_generated_from_csv() -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        "依赖图与 CSV 不一致 -- 跑 `uv run scripts/wayfinder-graph.py` 重新生成\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
