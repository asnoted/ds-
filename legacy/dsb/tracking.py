"""追踪文件并在每次对话之间注入 diff -- 以 git diff 为唯一事实来源.

为什么换成 git(2026-10-22):旧实现把每个文件的**内容**存一份快照(``.cache/dsb/
snapshots/<sha>.snapshot``),基线是"上次调用 ``tracked_diff`` 时文件的样子".
模型看到的 diff 于是与 ``git diff`` 对不上:基线不是 HEAD,用户一 commit 两边就分叉.
用户的原话:"模型看到的 diff 和 git 对不上,困惑".

新语义:

- 基线是**上一次注入时 ``git diff`` 的文本**(按文件切成段,存 ``anchor.json``);
- 每次取 diff 跑一遍 ``git diff``,只交出**与基线不同的那些文件的段**;
- 消费(``consume=True``)时把当前段存成新基线.

于是模型看到的就是 git 眼里的改动;用户 commit 之后 ``git diff`` 空了,也就不再注入.
未跟踪文件单列一行文件名(没内容可 diff),不让模型以为它们不存在.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from dsb.mcp import Tool

#: 状态目录(相对 work_root);用户不想要就把 .cache 加到 .gitignore.
STATE_DIRNAME = ".cache/dsb"
#: 整个结果的字数上限.
MAX_TOTAL_CHARS = 16000
#: 基线文件名:``{ path: 该文件的 git diff 段 }``.
ANCHOR_FILENAME = "anchor.json"
#: 待消费的段:预拉把"模型将看到的状态"存这儿,消费把它前移成新基线.
PENDING_FILENAME = "pending.json"


def _state_dir(root: Path) -> Path:
    path = root / STATE_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def _git(root: Path, args: list[str]) -> str | None:
    """跑一趟 git;跑不了(不在仓里 / 没装 git)回 None."""
    try:
        done = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return done.stdout


def git_diff_text(root: Path) -> str:
    """当前 ``git diff`` 的全文;不在 git 仓里回空串."""
    diff = _git(root, ["--no-pager", "diff", "--no-color", "--no-ext-diff"])
    if diff is None:
        return ""
    status = _git(
        root,
        ["--no-pager", "status", "--porcelain", "--untracked-files=all", "--no-color"],
    )
    untracked = [
        line[3:].strip()
        for line in (status or "").splitlines()
        if line.startswith("?? ")
    ]
    if untracked:
        if diff and not diff.endswith("\n"):
            diff += "\n"
        diff += "".join(f"--- 未跟踪: {name} ---\n" for name in untracked)
    return diff


def _split_sections(text: str) -> dict[str, str]:
    """按 ``diff --git`` 把全文切成 ``{ 相对路径: 该文件的段 }``.

    未跟踪文件那几行(``--- 未跟踪: x ---``)不挂在任何文件下,单独归到
    ``__untracked__`` 这个键,消费时一并前移.
    """
    sections: dict[str, str] = {}
    current: str | None = None
    buffer: list[str] = []
    for line in text.splitlines():
        if line.startswith("diff --git "):
            if current is not None:
                sections[current] = "\n".join(buffer)
            after = line.split(" b/", 1)
            current = after[1] if len(after) == 2 else line
            buffer = [line]
            continue
        if current is None:
            if not line.strip():
                continue
            current = "__untracked__"
            buffer = [line]
            continue
        buffer.append(line)
    if current is not None:
        sections[current] = "\n".join(buffer)
    return sections


def _looks_like_sections(data: object) -> bool:
    """值必须是 git diff 段,不是旧版的 sha.

    旧版 ``pending.json`` / ``anchor.json`` 存的是 ``{绝对路径: sha256}``,
    形状与 ``{路径: 段}`` 一样(都是 dict[str, str]),类型检查拦不住.不认这一层,
    消费会把 sha 字典当成基线存进 ``anchor.json``,之后每一轮 ``anchor.get(path)``
    都是 None,永远输出全量--2026-10-22 升级时真撞上.
    """
    if not isinstance(data, dict):
        return False
    if not data:
        return True
    for value in data.values():
        if not isinstance(value, str):
            return False
        if "diff --git" not in value and "--- 未跟踪" not in value:
            return False
    return True


def _load_anchor(root: Path) -> dict[str, str] | None:
    path = _state_dir(root) / ANCHOR_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not _looks_like_sections(data):
        return None
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _save_anchor(root: Path, sections: dict[str, str]) -> None:
    (_state_dir(root) / ANCHOR_FILENAME).write_text(
        json.dumps(sections, ensure_ascii=False), encoding="utf-8"
    )


def _load_pending(root: Path) -> dict[str, str] | None:
    path = _state_dir(root) / PENDING_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not _looks_like_sections(data):
        return None
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _save_pending(root: Path, sections: dict[str, str]) -> None:
    (_state_dir(root) / PENDING_FILENAME).write_text(
        json.dumps(sections, ensure_ascii=False), encoding="utf-8"
    )


def _clear_pending(root: Path) -> None:
    (_state_dir(root) / PENDING_FILENAME).unlink(missing_ok=True)


def sync_anchor(root: Path) -> None:
    """把当前 ``git diff`` 存成基线,同时把 pending 也设成它.工具执行成功后调一次.

    pending 也设:若消息发送时用的 pendingDiff 是写之前的旧快照,消费会把基线前移到
    那个旧状态,这次写就会被当成"新变更"再报一遍(模型看到自己刚做的事).两处同步
    前移,写之前的内容就不会再来.
    """
    current = _split_sections(git_diff_text(root))
    _save_anchor(root, current)
    _save_pending(root, current)


def trackingdiff(root: Path, consume: bool = False) -> dict:
    """返回自上次基线以来 ``git diff`` 的变化.

    ``consume=False``(预拉):算当前 ``git diff``,把与基线不同的文件段交出来,
    并把**当前**存成 ``pending``--那正是模型将看到的那个状态.

    ``consume=True``(消费):把基线前移到 ``pending``(即"模型刚才看到的状态"),
    清 ``pending``.这里**不重跑 git diff**:预拉到消费之间若文件又变过,重跑会把
    那段新变化当前基线,下一轮再也看不到它.
    """
    if consume:
        pending = _load_pending(root)
        if pending is not None:
            _save_anchor(root, pending)
            _clear_pending(root)
        return {"files": [], "count": 0}

    current = _split_sections(git_diff_text(root))
    anchor = _load_anchor(root) or {}
    files: list[dict] = []
    total = 0
    for path, section in current.items():
        if anchor.get(path) == section:
            continue
        if total >= MAX_TOTAL_CHARS:
            files.append(
                {"path": "(truncated)", "status": "note", "diff": "总结果超过上限,其余变更省略"}
            )
            break
        remaining = MAX_TOTAL_CHARS - total
        text = section if len(section) <= remaining else section[:remaining]
        files.append({"path": path, "status": "modified", "diff": text})
        total += len(section)

    _save_pending(root, current)
    return {"files": files, "count": len(files)}


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


def _trackingdiff_handler(root: Path):
    def handle(arguments):
        consume = bool(arguments.get("consume", False))
        text = format_for_model(trackingdiff(root, consume=consume))
        return {"text": text if text else "(无变更)"}, False

    return handle


def tools(root: Path) -> list[Tool]:
    return [
        Tool(
            name="trackingdiff",
            description="取回自上次注入以来 git diff 的变化.",
            input_schema={"type": "object", "properties": {}},
            handler=_trackingdiff_handler(root),
        ),
    ]


def cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="dsb track", description="查看 git 变更")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("diff", help="显示并前移 diff")
    sub.add_parser("reset", help="清空基线")
    args = parser.parse_args(argv)

    from dsb.config import find_dotenv
    from dsb.work import resolve_work_root

    path = find_dotenv()
    env_text = path.read_text(encoding="utf-8") if path is not None else ""
    root = resolve_work_root(env_text)

    if args.command == "diff":
        text = format_for_model(trackingdiff(root, consume=True))
        print(text if text else "(无变更)")
        return 0
    if args.command == "reset":
        (_state_dir(root) / ANCHOR_FILENAME).unlink(missing_ok=True)
        (_state_dir(root) / PENDING_FILENAME).unlink(missing_ok=True)
        print("已清空")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(cli(sys.argv[1:]))
