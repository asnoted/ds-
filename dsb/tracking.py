"""追踪文件并在每次对话之间注入 diff.

三件工具给模型:``track_file`` / ``untrack_file`` / ``tracked_diff``;
命令行同款:``dsb track add|rm|list|diff|reset``.

状态落在 ``<work_root>/.cache/dsb/``:

- ``tracked.json``:追踪列表(相对路径 / 绝对路径 / sha / 行数 / 时间);
- ``snapshots/<sha>.snapshot``:每个文件上次"看"过的内容.

``tracked_diff`` 每次调用**前移快照**,所以它返回的是"自上次调用以来"的
变更.与 git 无关:``difflib.unified_diff`` 就够,不假设用户在 git 仓库里.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import sys
import time
from pathlib import Path

from dsb.mcp import Tool

#: 状态目录(相对 work_root);用户不想要就把 .cache 加到 .gitignore.
STATE_DIRNAME = ".cache/dsb"

#: 单个文件 diff 的字符上限;超了截断并写明原长.
MAX_DIFF_CHARS = 4000
#: 整个 tracked_diff 结果的字符上限.
MAX_TOTAL_CHARS = 16000
#: 上次预拉(``consume=False``)时各追踪文件的 sha;消费只前移到这一刻.
PENDING_FILENAME = "pending.json"
#: unified diff 前后各留几行上下文.
DIFF_CONTEXT = 5


def _state_dir(root: Path) -> Path:
    path = root / STATE_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    (path / "snapshots").mkdir(parents=True, exist_ok=True)
    return path


def _sha_of_path(abs_path: str) -> str:
    return hashlib.sha256(abs_path.encode("utf-8")).hexdigest()


def _snapshot_path(root: Path, abs_path: str) -> Path:
    return _state_dir(root) / "snapshots" / f"{_sha_of_path(abs_path)}.snapshot"


def _load_state(root: Path) -> dict:
    state_file = _state_dir(root) / "tracked.json"
    if not state_file.is_file():
        return {"version": 1, "tracked": []}
    try:
        data = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "tracked": []}
    if not isinstance(data, dict) or not isinstance(data.get("tracked"), list):
        return {"version": 1, "tracked": []}
    return data


def _save_state(root: Path, state: dict) -> None:
    state_file = _state_dir(root) / "tracked.json"
    state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _to_relative(root: Path, path: str) -> tuple[Path, str]:
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = root / p
    abs_path = p.resolve()
    try:
        rel = str(abs_path.relative_to(root.resolve()))
    except ValueError:
        rel = str(abs_path)
    return abs_path, rel


def _snapshot_content(root: Path, abs_path: str) -> str | None:
    return _read_text(_snapshot_path(root, abs_path))


def _write_snapshot(root: Path, abs_path: str, content: str) -> None:
    _snapshot_path(root, abs_path).write_text(content, encoding="utf-8")


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n...(已截断:原文 {len(text)} 字,这里是前 {limit} 字)"


def _diff_one(current: str, previous: str, path: str) -> str:
    lines = difflib.unified_diff(
        previous.splitlines(keepends=True),
        current.splitlines(keepends=True),
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
        n=DIFF_CONTEXT,
    )
    return _truncate("".join(lines), MAX_DIFF_CHARS)


def track_add(root: Path, path: str) -> dict:
    abs_path, rel = _to_relative(root, path)
    content = _read_text(abs_path)
    if content is None:
        return {"error": f"file-not-found: {rel}"}
    sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
    lines = content.count("\n") + (0 if content.endswith("\n") or content == "" else 1)
    _write_snapshot(root, str(abs_path), content)
    state = _load_state(root)
    entries = [e for e in state["tracked"] if e.get("abs") != str(abs_path)]
    entries.append(
        {
            "path": rel,
            "abs": str(abs_path),
            "sha256": sha,
            "lines": lines,
            "tracked_at": time.time(),
        }
    )
    state["tracked"] = entries
    _save_state(root, state)
    return {"path": rel, "lines": lines, "sha256": sha}


def track_remove(root: Path, path: str) -> dict:
    abs_path, rel = _to_relative(root, path)
    state = _load_state(root)
    before = len(state["tracked"])
    state["tracked"] = [e for e in state["tracked"] if e.get("abs") != str(abs_path)]
    removed = before - len(state["tracked"])
    _save_state(root, state)
    snap = _snapshot_path(root, str(abs_path))
    if snap.is_file():
        snap.unlink(missing_ok=True)
    return {"path": rel, "removed": removed > 0}


def ensure_tracked(root: Path, path: str) -> None:
    """没在追踪就建一次基准快照;已在追踪则**完全不动**--快照只在出站交付 diff 时由
    ``tracked_diff(consume=True)`` 前移,读文件不能把用户的改动吃掉."""
    abs_path, _ = _to_relative(root, path)
    # 状态目录自己的文件不追踪:写追踪表就会改它,自指成永远有 diff 的噪音.
    state_dir = _state_dir(root).resolve()
    if abs_path == state_dir or state_dir in abs_path.parents:
        return
    state = _load_state(root)
    if any(e.get("abs") == str(abs_path) for e in state["tracked"]):
        return
    track_add(root, path)


def track_list(root: Path) -> dict:
    state = _load_state(root)
    return {
        "tracked": [
            {"path": e.get("path"), "lines": e.get("lines"), "tracked_at": e.get("tracked_at")}
            for e in state["tracked"]
        ]
    }


def _load_pending(root: Path) -> dict[str, str] | None:
    """上次预拉时各追踪文件的 sha;没有就回 ``None``(消费按当下前移兜底)."""
    path = _state_dir(root) / PENDING_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _save_pending(root: Path, shas: dict[str, str]) -> None:
    (_state_dir(root) / PENDING_FILENAME).write_text(
        json.dumps(shas, ensure_ascii=False), encoding="utf-8"
    )


def _clear_pending(root: Path) -> None:
    (_state_dir(root) / PENDING_FILENAME).unlink(missing_ok=True)


def tracked_diff(root: Path, consume: bool = False) -> dict:
    """返回自上次调用以来所有追踪文件的变更.

    ``consume=False`` 是预拉:算 diff,并把「这一刻各文件的 sha」记进 ``pending.json``.
    ``consume=True`` 是消费:只对**当前 sha 仍等于上次预拉那一刻**的文件前移快照--
    预拉(最多 10s 前)到消费之间又变过的文件保持旧基准,下一轮再报.否则那段改动会被
    前移吃掉:既没进过任何注入,也不会再出现.没有 pending(从未预拉)时按当下前移兜底.
    """
    state = _load_state(root)
    pending = _load_pending(root) if consume else None
    seen_shas: dict[str, str] = {}
    diffs: list[dict] = []
    total = 0
    for entry in state["tracked"]:
        abs_path = entry.get("abs")
        path = entry.get("path")
        if not abs_path or not path:
            continue
        current = _read_text(Path(abs_path))
        if current is None:
            previous = _snapshot_content(root, abs_path)
            if previous is not None:
                diffs.append({"path": path, "status": "deleted"})
                _snapshot_path(root, abs_path).unlink(missing_ok=True)
            continue
        current_sha = hashlib.sha256(current.encode("utf-8")).hexdigest()
        seen_shas[abs_path] = current_sha
        previous = _snapshot_content(root, abs_path)
        if previous is None:
            _write_snapshot(root, abs_path, current)
            continue
        if current == previous:
            continue
        diff_text = _diff_one(current, previous, path)
        status = "added" if previous == "" else "modified"
        diffs.append({"path": path, "status": status, "diff": diff_text})
        if consume and (pending is None or pending.get(abs_path) == current_sha):
            _write_snapshot(root, abs_path, current)
        total += len(diff_text)
        if total >= MAX_TOTAL_CHARS:
            diffs.append(
                {"path": "(truncated)", "status": "note", "diff": "总结果超过上限,其余变更省略"}
            )
            break
    if consume:
        _clear_pending(root)
    else:
        _save_pending(root, seen_shas)
    return {"files": diffs, "count": len(diffs)}


def format_for_model(result: dict) -> str:
    """tracked_diff 的结果 → 一段给模型看的文本;空 = 无变更."""
    parts: list[str] = []
    for entry in result.get("files", []):
        status = entry.get("status")
        path = entry.get("path", "?")
        if status == "deleted":
            parts.append(f"--- {path} 已删除 ---")
        elif status == "note":
            parts.append(f"({entry.get('diff', '')})")
        else:
            diff = entry.get("diff", "")
            if diff:
                parts.append(diff)
    return "\n\n".join(parts)


def _track_file_handler(root: Path):
    def handle(arguments):
        path = arguments.get("path")
        if not isinstance(path, str) or not path:
            return {"text": "path required"}, True
        result = track_add(root, path)
        if "error" in result:
            return {"text": result["error"]}, True
        return {"text": json.dumps(result, ensure_ascii=False)}, False

    return handle


def _untrack_file_handler(root: Path):
    def handle(arguments):
        path = arguments.get("path")
        if not isinstance(path, str) or not path:
            return {"text": "path required"}, True
        return {"text": json.dumps(track_remove(root, path), ensure_ascii=False)}, False

    return handle


def _tracked_diff_handler(root: Path):
    def handle(arguments):
        consume = bool(arguments.get("consume", False))
        text = format_for_model(tracked_diff(root, consume=consume))
        return {"text": text if text else "(无变更)"}, False

    return handle


def tools(root: Path) -> list[Tool]:
    return [
        Tool(
            name="track_file",
            description="追踪一个文件:记下当前内容作为基准,后续变更会在下一轮对话注入 diff.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=_track_file_handler(root),
        ),
        Tool(
            name="untrack_file",
            description="取消追踪一个文件.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=_untrack_file_handler(root),
        ),
        Tool(
            name="tracked_diff",
            description="取回所有追踪文件自上次调用以来的变更.",
            input_schema={
                "type": "object",
                "properties": {},
            },
            handler=_tracked_diff_handler(root),
        ),
    ]


def cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="dsb track", description="追踪文件并查看变更")
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", help="开始追踪一个文件")
    add.add_argument("path")
    rm = sub.add_parser("rm", help="取消追踪一个文件")
    rm.add_argument("path")
    sub.add_parser("list", help="列出正在追踪的文件")
    sub.add_parser("diff", help="显示并前移 diff")
    sub.add_parser("reset", help="清空所有追踪")
    args = parser.parse_args(argv)

    from dsb.config import find_dotenv
    from dsb.work import resolve_work_root

    path = find_dotenv()
    env_text = path.read_text(encoding="utf-8") if path is not None else ""
    root = resolve_work_root(env_text)

    if args.command == "add":
        result = track_add(root, args.path)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if "error" not in result else 1
    if args.command == "rm":
        print(json.dumps(track_remove(root, args.path), ensure_ascii=False))
        return 0
    if args.command == "list":
        entries = track_list(root)["tracked"]
        if not entries:
            print("  (无追踪)")
        for entry in entries:
            print(f"  {entry['path']}  ({entry['lines']} 行)")
        return 0
    if args.command == "diff":
        text = format_for_model(tracked_diff(root, consume=True))
        print(text if text else "(无变更)")
        return 0
    if args.command == "reset":
        state_dir = _state_dir(root)
        (state_dir / "tracked.json").unlink(missing_ok=True)
        for snap in (state_dir / "snapshots").glob("*.snapshot"):
            snap.unlink()
        print("已清空")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(cli(sys.argv[1:]))
