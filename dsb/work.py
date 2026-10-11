"""dsb 内建的工作工具:``ls`` / ``read`` / ``grep`` / ``write`` / ``edit``(ADR-0012).

给网页模型一套能动手改本机文件的工作面,但**不给 SHELL**--任意命令天生能越界,与
'全部动作钉死在一个工作文件夹 root 内'冲突.五件工具全部把路径 ``resolve()`` 后判在
root 内,越界当场拒绝(``out-of-root``),相对路径以 root 为基准;写/改只额外拒 ``.git/``.

模块自己一件事:路径沙箱与五件工具的**纯逻辑**(对 ``root: Path`` 的函数),与 MCP 信封
解耦.``work_tools(root)`` 是唯一的薄适配层,把纯函数包成
``参数 -> (载荷, 这算不算失败)`` 的处理器(见 :class:`dsb.mcp.Tool`).dsb 只在
:func:`dsb.server.build_tools` 一处挂上它--将来换实现或挪进程,只动那一行.

不依赖 :mod:`dsb.gateway` / :mod:`dsb.server` / 网络;只 import 标准库,``dsb.config``
(root 解析)与 ``dsb.mcp``(注册形状).工具的失败与慢不在本模块留痕--:class:`dsb.mcp.McpService`
统一记一笔 ``tool-fail`` / ``tool-slow``(只留工具名与耗时,不带正文,ADR-0004).
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any

from dsb.config import env_value, repo_root
from dsb.mcp import Tool

#: 工作文件夹 root 的配置键:进程环境变量优先,其次 ``.env``,最后本仓根.
WORK_ROOT_ENV_KEY = "DSB_WORK_ROOT"

#: 上限(保护对话与前程):read 截断,ls 列数,grep 命中数,单行长度,参与 grep 的文件大小.
WORK_READ_LIMIT = 16_000
WORK_LIST_LIMIT = 500
WORK_GREP_LIMIT = 200
WORK_LINE_LIMIT = 500
WORK_FILE_LIMIT = 1_000_000
#: 探二进制时看的前缀长度:首块里出现 ``\x00`` 就当二进制,跳过.
WORK_BINARY_PROBE = 8_192

#: 工具载荷码册子(与 gateway 的三码,mcp.py 的 JSON-RPC 码分属三套,不混).
ERROR_OUT_OF_ROOT = "out-of-root"
ERROR_BAD_PATH = "bad-path"
ERROR_PROTECTED = "protected-path"
ERROR_NOT_FOUND = "not-found"
ERROR_NOT_A_FILE = "not-a-file"
ERROR_NOT_A_DIRECTORY = "not-a-directory"
ERROR_EDIT_NO_MATCH = "edit-no-match"
ERROR_EDIT_NOT_UNIQUE = "edit-not-unique"
ERROR_BAD_REGEX = "bad-regex"
ERROR_IO_FAILED = "io-failed"

#: 只写不读的护栏:``<root>/.git`` 之下(含 ``.git`` 本身,worktree 里 ``.git`` 是文件也算).
PROTECTED_DIR = ".git"

Payload = dict[str, Any]


class WorkError(Exception):
    """工作工具的错:``code`` 是册子里的字面量,``detail`` 是可选的给人看的话."""

    def __init__(self, code: str, detail: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def resolve_work_root(env_text: str) -> Path:
    """工作文件夹 root:进程环境变量优先,其次 ``.env``,最后本仓根;``~`` 照展开.

    root 存不存在不在这儿管--:func:`dsb.server.main` 打印一行,照常起服务,工具调用时
    才回 ``bad-path``(同'没配 MCP server 只打印一行'的口径).
    """
    raw = os.environ.get(WORK_ROOT_ENV_KEY) or env_value(env_text, WORK_ROOT_ENV_KEY)
    if raw is None:
        return repo_root()
    return Path(raw).expanduser()


def resolve_in_root(root: Path, raw: Any) -> Path:
    """路径沙箱:``raw`` 相对 root 解析(绝对路径也接受),``resolve()`` 后必须落在 root 内.

    ``resolve()`` 会跟随符号链接,并规范化 ``..``--链接逃逸与 ``..`` 一起挡住.不存在的
    路径用非 strict 解析:已存在的祖先先解析,再拼尾巴,仍能判越界;存不存在交给各工具.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise WorkError(ERROR_BAD_PATH, detail="路径不能为空")
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve()
        root_real = root.resolve()
    except (OSError, RuntimeError) as exc:  # 符号链接成环之类:解析不了就是坏路径
        raise WorkError(ERROR_BAD_PATH, detail=f"路径 {raw}") from exc
    if not _inside(root_real, resolved):
        raise WorkError(ERROR_OUT_OF_ROOT, detail=f"路径 {raw}")
    return resolved


def _inside(root_real: Path, resolved: Path) -> bool:
    """``resolved`` 是否在 root 内(含 root 自身)."""
    return resolved == root_real or root_real in resolved.parents


def protected_git(root: Path, resolved: Path) -> bool:
    """``resolved`` 是否在 ``<root>/.git`` 之下(含 ``.git`` 本身).读侧不拦,只写/改拦.

    两侧现各解析一次:``resolved`` 正常已由 :func:`resolve_in_root` 归一,这里再兜一层,
    免得调用方递来未归一的路径(``/var`` 与 ``/private/var`` 这类)时护栏**静默放行**.
    """
    try:
        relative = resolved.resolve().relative_to(root.resolve())
    except (ValueError, OSError, RuntimeError):
        return False
    return relative.parts[:1] == (PROTECTED_DIR,)


def _require_root(root: Path) -> None:
    if not root.is_dir():
        raise WorkError(ERROR_BAD_PATH, detail=f"工作目录不存在:{root}")


def _relative_to_root(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root.resolve()))
    except ValueError:
        return str(path)


def list_dir(root: Path, raw: str = ".") -> str:
    """``ls``:直接子项,目录带尾 ``/``,按名排序;超 :data:`WORK_LIST_LIMIT` 截断."""
    _require_root(root)
    path = resolve_in_root(root, raw)
    if not path.exists():
        raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {raw}")
    if not path.is_dir():
        raise WorkError(ERROR_NOT_A_DIRECTORY, detail=f"路径 {raw}")
    try:
        entries = sorted(path.iterdir(), key=lambda item: item.name)
    except OSError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    lines = [
        f"{entry.name}/" if entry.is_dir() else entry.name for entry in entries[:WORK_LIST_LIMIT]
    ]
    if len(entries) > WORK_LIST_LIMIT:
        lines.append(f"...(已截断,共 {len(entries)} 项)")
    return "\n".join(lines) if lines else "(空)"


def read_text(root: Path, raw: str) -> str:
    """``read``:读 root 内一个文件;超 :data:`WORK_READ_LIMIT` 截断并标注."""
    _require_root(root)
    path = resolve_in_root(root, raw)
    if not path.exists():
        raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {raw}")
    if not path.is_file():
        raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {raw}")
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}(不是文本)") from exc
    except OSError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    if len(content) > WORK_READ_LIMIT:
        extra = len(content) - WORK_READ_LIMIT
        content = content[:WORK_READ_LIMIT] + f"\n...(已截断,超出 {extra} 字符)"
    return content


def write_text(root: Path, raw: str, content: str) -> int:
    """``write``:在 root 内新建/覆盖文件(自动建父目录),回写入的字节数."""
    _require_root(root)
    path = resolve_in_root(root, raw)
    if protected_git(root, path):
        raise WorkError(ERROR_PROTECTED, detail=f"路径 {raw}")
    if path.is_dir():
        raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {raw}")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    return len(content.encode("utf-8"))


def edit_text(root: Path, raw: str, old_string: str, new_string: str) -> int:
    """``edit``:``old_string`` 在文件里**唯一命中**才替换;0 处/多处回错码且文件不变."""
    _require_root(root)
    path = resolve_in_root(root, raw)
    if protected_git(root, path):
        raise WorkError(ERROR_PROTECTED, detail=f"路径 {raw}")
    if not path.exists():
        raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {raw}")
    if not path.is_file():
        raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {raw}")
    if not old_string:
        raise WorkError(ERROR_EDIT_NO_MATCH, detail="old_string 为空")
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    count = content.count(old_string)
    if count == 0:
        raise WorkError(ERROR_EDIT_NO_MATCH, detail=f"路径 {raw}")
    if count > 1:
        raise WorkError(ERROR_EDIT_NOT_UNIQUE, detail=f"路径 {raw}(命中 {count} 处)")
    try:
        path.write_text(content.replace(old_string, new_string, 1), encoding="utf-8")
    except OSError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    return 1


def _walk_files(base: Path) -> Iterator[Path]:
    """``base`` 下的文件(不跟符号链接目录,遍历时跳过 ``.git``)."""
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name != PROTECTED_DIR)
        for name in sorted(filenames):
            yield Path(dirpath) / name


def grep_tree(root: Path, pattern: str, raw: str = ".") -> str:
    """``grep``:在 root 内按正则搜文本行,回 ``相对路径:行号: 行``.

    有上限,跳二进制与 ``.git/``(体积/噪音).
    """
    _require_root(root)
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        raise WorkError(ERROR_BAD_REGEX, detail=f"正则 {pattern!r}") from exc
    base = resolve_in_root(root, raw)
    if not base.exists():
        raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {raw}")
    root_real = root.resolve()
    targets = [base] if base.is_file() else _walk_files(base)
    hits: list[str] = []
    truncated = False
    for file in targets:
        try:
            resolved = file.resolve()  # 逐个再解析:别让 root 内指向外面的符号链接漏读
        except (OSError, RuntimeError):
            continue
        if not _inside(root_real, resolved) or protected_git(root, resolved):
            continue
        try:
            if resolved.stat().st_size > WORK_FILE_LIMIT:
                continue
            data = resolved.read_bytes()
        except OSError:
            continue
        if b"\x00" in data[:WORK_BINARY_PROBE]:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        relative = _relative_to_root(root, resolved)
        for number, line in enumerate(text.splitlines(), start=1):
            if not regex.search(line):
                continue
            hits.append(f"{relative}:{number}: {line[:WORK_LINE_LIMIT]}")
            if len(hits) >= WORK_GREP_LIMIT:
                truncated = True
                break
        if truncated:
            break
    if truncated:
        hits.append(f"...(命中数达上限 {WORK_GREP_LIMIT},已截断)")
    return "\n".join(hits) if hits else "(无命中)"


def _wrap(action: Callable[[], str]) -> tuple[Payload, bool]:
    """纯函数 → 处理器载荷:``WorkError`` 折成 ``code(detail)`` 的失败正文."""
    try:
        return {"text": action()}, False
    except WorkError as error:
        body = error.code if error.detail is None else f"{error.code}({error.detail})"
        return {"text": body}, True


def _bad_path(detail: str) -> tuple[Payload, bool]:
    return {"text": f"{ERROR_BAD_PATH}({detail})"}, True


def work_tools(root: Path) -> list[Tool]:
    """五件工作工具:把纯函数包成 :class:`dsb.mcp.Tool`(相对路径以 ``root`` 为基准)."""

    def ls_handler(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        raw = arguments.get("path")
        return _wrap(lambda: list_dir(root, "." if raw is None else raw))

    def read_handler(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        raw = arguments.get("path")
        if not isinstance(raw, str) or not raw.strip():
            return _bad_path("缺少 path")
        return _wrap(lambda: read_text(root, raw))

    def grep_handler(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        pattern = arguments.get("pattern")
        raw = arguments.get("path")
        if not isinstance(pattern, str):
            return {"text": f"{ERROR_BAD_REGEX}(pattern 必须是字符串)"}, True
        return _wrap(lambda: grep_tree(root, pattern, "." if raw is None else raw))

    def write_handler(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        raw = arguments.get("path")
        content = arguments.get("content")
        if not isinstance(raw, str) or not raw.strip():
            return _bad_path("缺少 path")
        if not isinstance(content, str):
            return _bad_path("content 必须是字符串")
        return _wrap(lambda: f"已写入 {write_text(root, raw, content)} 字节:{raw}")

    def edit_handler(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        raw = arguments.get("path")
        old = arguments.get("old_string")
        new = arguments.get("new_string")
        if not isinstance(raw, str) or not raw.strip():
            return _bad_path("缺少 path")
        if not isinstance(old, str):
            return _bad_path("缺少 old_string")
        if not isinstance(new, str):
            return _bad_path("缺少 new_string")
        return _wrap(lambda: f"已替换 {edit_text(root, raw, old, new)} 处:{raw}")

    return [
        Tool(
            name="ls",
            description="[工作目录] 列出工作目录内某个目录的直接子项(目录带尾 /).path 缺省 ..",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
            handler=ls_handler,
        ),
        Tool(
            name="read",
            description="[工作目录] 读工作目录内一个文件;超长截断并标注.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=read_handler,
        ),
        Tool(
            name="grep",
            description="[工作目录] 在工作目录内按正则搜索文本行,回 相对路径:行号: 行.",
            input_schema={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string"},
                },
                "required": ["pattern"],
            },
            handler=grep_handler,
        ),
        Tool(
            name="write",
            description="[工作目录] 在工作目录内新建/覆盖文件(自动建父目录),回写入字节数.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
            handler=write_handler,
        ),
        Tool(
            name="edit",
            description="[工作目录] 在工作目录内把唯一命中的 old_string 替换成 new_string.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                },
                "required": ["path", "old_string", "new_string"],
            },
            handler=edit_handler,
        ),
    ]


__all__ = [
    "ERROR_BAD_PATH",
    "ERROR_BAD_REGEX",
    "ERROR_EDIT_NO_MATCH",
    "ERROR_EDIT_NOT_UNIQUE",
    "ERROR_IO_FAILED",
    "ERROR_NOT_A_DIRECTORY",
    "ERROR_NOT_A_FILE",
    "ERROR_NOT_FOUND",
    "ERROR_OUT_OF_ROOT",
    "ERROR_PROTECTED",
    "PROTECTED_DIR",
    "WORK_FILE_LIMIT",
    "WORK_GREP_LIMIT",
    "WORK_LINE_LIMIT",
    "WORK_LIST_LIMIT",
    "WORK_READ_LIMIT",
    "WORK_ROOT_ENV_KEY",
    "WorkError",
    "edit_text",
    "grep_tree",
    "list_dir",
    "protected_git",
    "read_text",
    "resolve_in_root",
    "resolve_work_root",
    "work_tools",
    "write_text",
]
