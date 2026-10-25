"""dsb 内建的工作工具:``glob`` / ``read`` / ``grep`` / ``write`` / ``edit``.

工具实现不在这儿了:五件都来自上游 ``@earendil-works/pi-coding-agent``,由
``scripts/pi-tools.mjs`` 作为 MCP stdio 子进程提供.本模块只剩
dsb 自己的那一半--**信任边界**:

- 路径 ``resolve()`` 后必须落在 root 内,越界当场拒绝(``out-of-root``);
- root 内的权限规则(:mod:`dsb.permissions`,#89):``mcp.json`` / ``.env`` 系文件默认
  读写都拒,``.git/`` 与它们写/改也拒;
- 整条结果的 16K 闸与 write/edit 之后的 ``git diff`` 基线同步。

上游只管"怎么读、怎么搜、怎么写";会不会越界、能不能读那个文件,由这里先判。这样换
实现或挪进程只动这一个文件,权限规则仍然只有一处。
"""

from __future__ import annotations

import os
import re
import sys
import unicodedata
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from dsb.config import env_value, find_dotenv, repo_root, resolve_config_path
from dsb.gateway import (
    START_TIMEOUT,
    GatewayError,
    StdioServer,
    resolve_timeout,
    text_of_result,
)
from dsb.log import log_event
from dsb.mcp import Tool
from dsb.permissions import Operation, is_allowed

#: 工作文件夹 root 的配置键:进程环境变量优先,其次 ``.env``,最后本仓根.
WORK_ROOT_ENV_KEY = "DSB_WORK_ROOT"

#: ``read`` 的翻页:默认一页 200 行,上限 2000(与 pi 的上游上限一致).
WORK_READ_PAGE_LINES = 200
WORK_READ_MAX_LINES = 2_000
#: ``grep`` 的墙钟:子进程卡住时父进程收掉它,回一个能让模型改写的码(旧 0010).
WORK_GREP_DEADLINE = 20.0
#: **整条结果**的最后一道闸:超过就砍在行边界上,末行说清接着怎么办.
#: 与扩展侧那道 ``MAX_RESULT_CHARS`` 同数,所以一条结果能原样进对话(旧 0010).
WORK_RESULT_CHARS = 16_000

#: 工具载荷码册子(与 gateway 的三码,mcp.py 的 JSON-RPC 码分属三套,不混).
ERROR_OUT_OF_ROOT = "out-of-root"
ERROR_BAD_PATH = "bad-path"
ERROR_PROTECTED = "protected-path"
ERROR_BAD_RANGE = "bad-range"
ERROR_NOT_FOUND = "not-found"
ERROR_NOT_A_FILE = "not-a-file"
ERROR_EXISTS = "file-exists"
ERROR_EDIT_NO_MATCH = "edit-no-match"
ERROR_EDIT_NOT_UNIQUE = "edit-not-unique"
ERROR_BAD_REGEX = "bad-regex"
ERROR_PATTERN_TOO_SLOW = "pattern-too-slow"
ERROR_IO_FAILED = "io-failed"

#: 失败回执被 :func:`cap_result` 砍掉之后给模型的那一步:``detail`` 是参数回显, 变小 =
#: 把参数改短(与 glob / grep 各自的 hint 同一条口径).
ERROR_HINT = "把参数改短或改窄再试"

#: 只写不读的护栏:``<root>/.git`` 之下(含 ``.git`` 本身,worktree 里 ``.git`` 是文件也算).
#: #89 起它是 :data:`dsb.permissions.DEFAULT_RULES` 里 ``edit`` 那份表的一条规则
#: (``.git`` / ``.git/*`` deny),这里只留字面量给 :func:`protected_git` 用.
PROTECTED_DIR = ".git"

#: dsb 实际会去读的那两个本机配置文件(#89):默认在仓根,但都能被配置改到别处.
MCP_CONFIG_ENV_KEY = "DSB_MCP_CONFIG"
ENV_FILE_NAME = ".env"

Payload = dict[str, Any]

#: 起着的 sidecar;``main`` 收摊时一并停掉(进程退出时 stdin 断开也会自己退).
_SIDECARS: list[StdioServer] = []


class WorkError(Exception):
    """工作工具的错:``code`` 是册子里的字面量,``detail`` 是可选的给人看的话."""

    def __init__(self, code: str, detail: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def resolve_work_root(env_text: str) -> Path:
    """工作文件夹 root:进程环境变量优先,其次 ``.env``,最后本仓根;``~`` 照展开."""
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
    except UnicodeError as exc:  # JSON 里的孤立代理字符:落不成文件系统编码
        raise WorkError(ERROR_BAD_PATH, detail=f"路径 {raw}") from exc
    except (OSError, RuntimeError, ValueError) as exc:  # 符号链接成环 / 内嵌 NUL 之类
        raise WorkError(ERROR_BAD_PATH, detail=f"路径 {raw}") from exc
    if not _inside(root_real, resolved):
        raise WorkError(ERROR_OUT_OF_ROOT, detail=f"路径 {raw}")
    return resolved


def _inside(root_real: Path, resolved: Path) -> bool:
    """``resolved`` 是否在 root 内(含 root 自身)."""
    return resolved == root_real or root_real in resolved.parents


def root_relative(root: Path, resolved: Path) -> str | None:
    """``resolved`` 的**根相对 POSIX 路径**(权限规则比对的输入);不在 root 内回 ``None``."""
    try:
        relative = resolved.resolve().relative_to(root.resolve())
    except (ValueError, OSError, RuntimeError):
        return None
    return relative.as_posix()


def _effective_sensitive(root: Path) -> tuple[Path, ...]:
    """dsb **真实生效**的那两个本机配置文件的绝对路径(可能不在 root 内,不做拦截)."""
    root_real = root.resolve()
    sensitive = [resolve_config_path(_dotenv_text()).resolve(), root_real / ENV_FILE_NAME]
    dotenv = find_dotenv()
    if dotenv is not None:
        sensitive.append(dotenv.resolve())
    return tuple(dict.fromkeys(sensitive))


def _dotenv_text() -> str:
    """``.env`` 原文(``resolve_config_path`` 要它;读不到就当没有,与别处同口径)."""
    dotenv = find_dotenv()
    if dotenv is None:
        return ""
    try:
        return dotenv.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        # 坏编码也只当没配:否则每次读/写/搜都在这儿炸成 tool-broke.
        return ""


def is_protected(root: Path, resolved: Path, operation: Operation) -> bool:
    """这个操作对这条路径**允不允许**(#89).不允许时调用方回 ``protected-path``.

    三层,顺序即代价从低到高:

    1. **规则表**(:mod:`dsb.permissions`):根相对 POSIX 路径 + 操作类别,
       最后命中的规则赢,大小写不敏感;
    2. **真实生效的本机配置**:``mcp.json``(或 ``DSB_MCP_CONFIG`` 指的那个)与 ``.env``,
       即便名字或位置与默认不同,即便 root 被配成别处,落在 root 内一律读写都拒;
    3. 路径不在 root 内 → 这里不判(那是 :func:`resolve_in_root` 的 ``out-of-root``).
    """
    relative = root_relative(root, resolved)
    if relative is None:
        return False
    if not is_allowed(operation, relative):
        return True
    try:
        target = resolved.resolve()
        sensitive_paths = _effective_sensitive(root)
    except (OSError, RuntimeError):
        # 判不了就按"受保护"收场:这里放行等于在解析失败时把 mcp.json / .env 让出去.
        return True
    for sensitive in sensitive_paths:
        # 还没落盘的文件没有 inode 可比,按规范化后的路径比:macOS 上换个大小写 / Unicode
        # 写法(NFC 与 NFD)打开 / 写的是同一份,只折大小写仍会漏.
        left = unicodedata.normalize("NFC", str(target)).casefold()
        right = unicodedata.normalize("NFC", str(sensitive)).casefold()
        if left == right:
            return True
        # 同一个 inode 换个写法 / 硬链接也算:macOS 大小写不敏感,``RELAY.json`` 与
        # ``relay.json`` 是同一份文件;硬链接同理.按路径字符串比会漏.
        try:
            if os.path.samefile(target, sensitive):
                return True
        except OSError:
            continue
    return False


def protected_git(root: Path, resolved: Path) -> bool:
    """``resolved`` 是否在 ``<root>/.git`` 之下(含 ``.git`` 本身).读侧不拦,只写/改拦."""
    return (
        is_protected(root, resolved, "edit")
        and root_relative(root, resolved) is not None
        and root_relative(root, resolved).split("/")[0] == PROTECTED_DIR
    )


def _require_root(root: Path) -> None:
    if not root.is_dir():
        raise WorkError(ERROR_BAD_PATH, detail=f"工作目录不存在:{root}")


def _units(text: str) -> int:
    """这段正文在**扩展侧**量出来多长:dsb 与扩展必须用同一种单位(旧 0010).

    JS 的 ``.length`` 数的是 UTF-16 单元(星平面字--emoji 之类--算两个),Python 的
    :func:`len` 数的是码点(算一个).两边同数 = 这里按扩展的单位量.
    """
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def cap_result(text: str, hint: str) -> str:
    """整条结果的闸:超 :data:`WORK_RESULT_CHARS` 字就砍,末行说清接着怎么办.

    **任何正文进来,出门的那一整条(连末句)都 <=** :data:`WORK_RESULT_CHARS`--末句不算
    进去就会越过扩展那道同数的闸,被截掉的正是"怎么续"那句(旧 0010).
    """
    if _units(text) <= WORK_RESULT_CHARS:
        return text
    rows = text.splitlines()
    room = _units(_result_note(len(rows), len(rows), hint))
    kept: list[str] = []
    used = 0
    for row in rows:
        cost = _units(row) + 1
        if used + cost + room > WORK_RESULT_CHARS:
            break
        used += cost
        kept.append(row)
    if not kept:
        return _cut_first_row(rows[0], hint)
    return "\n".join([*kept, _result_note(len(kept), len(rows), hint)])


def _cut_first_row(row: str, hint: str) -> str:
    """第一行一整个放不下:在行内砍,末句说清这一行被砍在哪(旧 0010)."""
    note = f"\n...(这一行超 {WORK_RESULT_CHARS} 字,已截断:原文 {_units(row)} 字;{hint})"
    if _units(note) >= WORK_RESULT_CHARS:
        return row
    return _cut_units(row, WORK_RESULT_CHARS - _units(note)) + note


def _cut_units(text: str, budget: int) -> str:
    """取开头一段,长度不超过 ``budget`` 个 UTF-16 单元(与 :func:`_units` 同一把尺)."""
    cut = text[:budget]
    drop = _units(cut) - budget
    while drop > 0 and cut:
        drop -= 2 if ord(cut[-1]) > 0xFFFF else 1
        cut = cut[:-1]
    return cut


def _result_note(kept: int, total: int, hint: str) -> str:
    """截断末句:说清给了多少、砍了多少,以及接着该怎么办."""
    return f"...(整条超 {WORK_RESULT_CHARS} 字,已截断:给了前 {kept} 行 / 共 {total} 行;{hint})"


def _clean_glob_pattern(pattern: str) -> str:
    """``glob`` 的模式只收 root 内的相对路径:反斜杠折成 ``/``,拒绝绝对路径与 ``..``."""
    normalized = pattern.replace("\\", "/").rstrip("/")
    if not normalized:
        raise WorkError(ERROR_BAD_PATH, detail="pattern 不能为空")
    if normalized.startswith("/") or any(part == ".." for part in normalized.split("/")):
        raise WorkError(ERROR_BAD_PATH, detail="pattern 必须是工作目录内的相对路径")
    if "\x00" in normalized:
        raise WorkError(ERROR_BAD_PATH, detail="pattern 不能含 NUL")
    return normalized


def _fail(error: WorkError) -> tuple[Payload, bool]:
    body = error.code if error.detail is None else f"{error.code}({error.detail})"
    return {"text": cap_result(body, ERROR_HINT)}, True


def _hint(name: str) -> str:
    return {
        "glob": "收窄 pattern,或换一个更具体的目录",
        "read": "用更小的 limit,或按末尾提示的 offset 接着读",
        "grep": "收窄模式,或指定 path 分几次搜",
    }.get(name, ERROR_HINT)


def _prepare(root: Path, name: str, arguments: Mapping[str, Any]) -> Payload:
    """把模型给的一件调用变成**已过信任边界**的 sidecar 入参;越界/受保护在这之前拒掉."""
    if name == "glob":
        pattern = arguments.get("pattern")
        if not isinstance(pattern, str) or not pattern.strip():
            raise WorkError(ERROR_BAD_PATH, detail="缺少 pattern")
        _require_root(root)
        prepared: Payload = {"pattern": _clean_glob_pattern(pattern)}
        if arguments.get("path") is not None:
            prepared["path"] = str(resolve_in_root(root, arguments["path"]))
        limit = arguments.get("limit")
        if limit is not None:
            if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
                raise WorkError(ERROR_BAD_RANGE, detail="limit 必须是正整数")
            prepared["limit"] = limit
        return prepared

    if name == "read":
        _require_root(root)
        path = resolve_in_root(root, arguments.get("path"))
        if is_protected(root, path, "read"):
            raise WorkError(ERROR_PROTECTED, detail=f"路径 {arguments.get('path')}(读侧受保护)")
        if not path.exists():
            raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {arguments.get('path')}")
        if not path.is_file():
            raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {arguments.get('path')}")
        offset = arguments.get("offset", 1)
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 1:
            raise WorkError(ERROR_BAD_RANGE, detail=f"offset={offset}(行号从 1 起)")
        limit = arguments.get("limit", WORK_READ_PAGE_LINES)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise WorkError(ERROR_BAD_RANGE, detail=f"limit={limit}(至少 1 行)")
        return {
            "path": str(path),
            "offset": offset,
            "limit": min(limit, WORK_READ_MAX_LINES),
        }

    if name == "grep":
        pattern = arguments.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise WorkError(ERROR_BAD_REGEX, detail="pattern 必须是非空字符串")
        _require_root(root)
        raw = arguments.get("path")
        path = resolve_in_root(root, "." if raw is None else raw)
        if not path.exists():
            raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {raw or '.'}")
        prepared = {"pattern": pattern, "path": str(path)}
        for key, kind in (("glob", str), ("ignoreCase", bool), ("literal", bool)):
            value = arguments.get(key)
            if value is not None:
                if not isinstance(value, kind) or (kind is str and not value):
                    raise WorkError(ERROR_BAD_PATH, detail=f"{key} 类型不对")
                prepared[key] = value
        for key in ("context", "limit"):
            value = arguments.get(key)
            if value is not None:
                if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                    raise WorkError(ERROR_BAD_RANGE, detail=f"{key} 必须是非负整数")
                prepared[key] = value
        return prepared

    if name == "write":
        _require_root(root)
        content = arguments.get("content")
        overwrite = arguments.get("overwrite", False)
        if not isinstance(content, str):
            raise WorkError(ERROR_BAD_PATH, detail="content 必须是字符串")
        if not isinstance(overwrite, bool):
            raise WorkError(ERROR_BAD_PATH, detail="overwrite 必须是布尔值")
        path = resolve_in_root(root, arguments.get("path"))
        if is_protected(root, path, "edit"):
            raise WorkError(ERROR_PROTECTED, detail=f"路径 {arguments.get('path')}")
        if path.is_dir():
            raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {arguments.get('path')}")
        if path.exists() and not overwrite:
            raise WorkError(
                ERROR_EXISTS, detail=f"路径 {arguments.get('path')}(要覆盖请传 overwrite=true)"
            )
        return {"path": str(path), "content": content, "overwrite": overwrite}

    if name == "edit":
        _require_root(root)
        path = resolve_in_root(root, arguments.get("path"))
        if is_protected(root, path, "edit"):
            raise WorkError(ERROR_PROTECTED, detail=f"路径 {arguments.get('path')}")
        if not path.exists():
            raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {arguments.get('path')}")
        if not path.is_file():
            raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {arguments.get('path')}")
        edits = arguments.get("edits")
        if not isinstance(edits, list) or not edits:
            raise WorkError(ERROR_BAD_PATH, detail="edits 必须是非空数组")
        translated: list[dict[str, Any]] = []
        for index, edit in enumerate(edits, start=1):
            if not isinstance(edit, Mapping):
                raise WorkError(ERROR_BAD_PATH, detail=f"第 {index} 段不是对象")
            old = edit.get("oldText", edit.get("old"))
            new = edit.get("newText", edit.get("new"))
            if not isinstance(old, str) or not isinstance(new, str):
                raise WorkError(ERROR_BAD_PATH, detail=f"第 {index} 段缺少 oldText/newText")
            translated.append({"oldText": old, "newText": new})
        return {"path": str(path), "edits": translated}

    raise WorkError(ERROR_BAD_PATH, detail=f"未知工具 {name}")


_GREP_HIT = re.compile(r"^(?P<path>.+?)[:-]\d+[:-] ")


def _filter_grep(root: Path, prepared: Mapping[str, Any], text: str) -> str:
    """把受保护文件（``.env`` / ``mcp.json``）的命中行从结果里删掉（#89）。

    上游 grep 没有"别搜这些文件"的入参，所以只能后置过滤；内容已经进了 sidecar，但
    **不会进对话**。路径按搜索起点还原：pi 回的是相对起点/文件名的路径。
    """
    base = Path(prepared["path"])
    if not base.is_dir():
        base = base.parent
    root_real = root.resolve()
    kept: list[str] = []
    dropped = 0
    for line in text.splitlines():
        match = _GREP_HIT.match(line)
        if match:
            try:
                target = (base / match.group("path")).resolve()
            except (OSError, RuntimeError):
                kept.append(line)
                continue
            if not _inside(root_real, target) or is_protected(root, target, "read"):
                dropped += 1
                continue
        kept.append(line)
    if dropped:
        kept.append(f"...(已略过受保护文件 {dropped} 行)")
    return "\n".join(kept) if kept else "(无命中)"


def _sidecar(root: Path) -> StdioServer | None:
    """起一个 sidecar;起不来记一笔、回 ``None``(别的工具照常)."""
    script = repo_root() / "scripts" / "pi-tools.mjs"
    if not script.is_file():
        log_event("work-sidecar-missing", path=str(script))
        return None
    server = StdioServer(
        "work",
        [os.environ.get("DSB_NODE", "node"), str(script)],
        cwd=str(root if root.is_dir() else repo_root()),
        env={"DSB_WORK_ROOT": str(root), "PI_OFFLINE": "1"},
        start_timeout=START_TIMEOUT,
    )
    try:
        server.start()
    except GatewayError:
        log_event("work-sidecar-down", path=str(script))
        print(
            "[dsb] 工作工具 sidecar 起不来(先 pnpm install?);本次只剩网关与追踪工具.",
            file=sys.stderr,
        )
        return None
    _SIDECARS.append(server)
    return server


def stop_work_tools() -> None:
    """收摊:停掉本进程起过的所有 sidecar."""
    while _SIDECARS:
        _SIDECARS.pop().stop()


def _timeout() -> float:
    return resolve_timeout(_dotenv_text())


def _grep_timeout() -> WorkError:
    return WorkError(
        ERROR_PATTERN_TOO_SLOW,
        detail=f"模式未在 {WORK_GREP_DEADLINE:g}s 内搜完(换简单点的写法,或指定 path)",
    )


def _edit_error(text: str) -> WorkError | None:
    """pi 的编辑错误 → dsb 的两个码;认不出的交给调用方折成 ``io-failed``."""
    if "must be unique" in text:
        return WorkError(ERROR_EDIT_NOT_UNIQUE, detail=text)
    if "Could not find" in text or "oldText must not be empty" in text:
        return WorkError(ERROR_EDIT_NO_MATCH, detail=text)
    return None


def _handler(server: StdioServer, root: Path, name: str):
    def handle(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        try:
            prepared = _prepare(root, name, arguments)
            limit = WORK_GREP_DEADLINE if name == "grep" else _timeout()
            result = server.call_tool(name, prepared, limit)
        except WorkError as error:
            return _fail(error)
        except GatewayError as error:
            if name == "grep" and error.code == "tool-timeout":
                return _fail(_grep_timeout())
            return {"text": cap_result(f"{error.code}(工具 {name})", ERROR_HINT)}, True
        text, failed = text_of_result(result)
        if failed:
            if name == "grep" and text == "Operation aborted":
                return _fail(_grep_timeout())
            edit_error = _edit_error(text) if name == "edit" else None
            if edit_error is not None:
                return _fail(edit_error)
            return {"text": cap_result(f"{ERROR_IO_FAILED}({text})", ERROR_HINT)}, True
        if name == "grep":
            text = _filter_grep(root, prepared, text)
        payload: Payload = {"text": cap_result(text, _hint(name))}
        if name in {"write", "edit"}:
            _sync_anchor_after_write(root, (payload, False))
        return payload, False

    return handle


def _sync_anchor_after_write(root: Path, result: tuple[Payload, bool]) -> None:
    """write / edit 成功之后立刻把当前 ``git diff`` 记成基线."""
    if result[1]:
        return
    try:
        from dsb.tracking import sync_anchor

        sync_anchor(root)
    except Exception:  # noqa: BLE001 - 记基线失败不该把工具结果拖成失败
        pass


def work_tools(root: Path) -> list[Tool]:
    """工作工具面:把 sidecar 的五件工具包成 :class:`dsb.mcp.Tool`(相对路径以 ``root`` 为基准)."""
    server = _sidecar(root)
    if server is None:
        return []
    try:
        described = {item.get("name"): item for item in server.list_tools()}
    except GatewayError:
        log_event("work-sidecar-down", error="tools-list")
        return []
    tools: list[Tool] = []
    for name in ("glob", "read", "grep", "write", "edit"):
        descriptor = described.get(name)
        if not isinstance(descriptor, Mapping):
            continue
        schema = descriptor.get("inputSchema")
        tools.append(
            Tool(
                name=name,
                description=f"[工作目录] {descriptor.get('description', '')}".rstrip(),
                input_schema=schema if isinstance(schema, Mapping) else {"type": "object"},
                handler=_handler(server, root, name),
            )
        )
    return tools


def grep_tree(root: Path, pattern: str, raw: str = ".") -> str:
    """``grep`` 的进程内薄壳:给 ``scripts/measure-result-forms.py`` 取真实形态.

    与 MCP 那条路走同一份 :func:`_prepare` / :func:`_filter_grep` / :func:`cap_result`。
    """
    server = _sidecar(root)
    if server is None:
        raise WorkError(ERROR_IO_FAILED, detail="工作工具 sidecar 起不来")
    try:
        prepared = _prepare(root, "grep", {"pattern": pattern, "path": raw})
        try:
            result = server.call_tool("grep", prepared, WORK_GREP_DEADLINE)
        except GatewayError as error:
            code = ERROR_PATTERN_TOO_SLOW if error.code == "tool-timeout" else ERROR_IO_FAILED
            raise WorkError(code, detail=f"模式 {pattern!r}") from error
        text, failed = text_of_result(result)
        if failed:
            raise WorkError(ERROR_IO_FAILED, detail=text)
        return cap_result(_filter_grep(root, prepared, text), _hint("grep"))
    finally:
        server.stop()
        if server in _SIDECARS:
            _SIDECARS.remove(server)


__all__ = [
    "ERROR_BAD_PATH",
    "ERROR_BAD_RANGE",
    "ERROR_BAD_REGEX",
    "ERROR_EDIT_NO_MATCH",
    "ERROR_EDIT_NOT_UNIQUE",
    "ERROR_EXISTS",
    "ERROR_IO_FAILED",
    "ERROR_NOT_A_FILE",
    "ERROR_NOT_FOUND",
    "ERROR_OUT_OF_ROOT",
    "ERROR_PATTERN_TOO_SLOW",
    "ERROR_PROTECTED",
    "ENV_FILE_NAME",
    "MCP_CONFIG_ENV_KEY",
    "PROTECTED_DIR",
    "WORK_GREP_DEADLINE",
    "WORK_READ_MAX_LINES",
    "WORK_READ_PAGE_LINES",
    "WORK_RESULT_CHARS",
    "WORK_ROOT_ENV_KEY",
    "WorkError",
    "grep_tree",
    "is_protected",
    "protected_git",
    "resolve_in_root",
    "resolve_work_root",
    "root_relative",
    "stop_work_tools",
    "work_tools",
]
