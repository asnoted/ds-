"""dsb 内建的工作工具:``ls`` / ``read`` / ``grep`` / ``write`` / ``edit``(旧 0009).

给网页模型一套能动手改本机文件的工作面,但**不给 SHELL**--任意命令天生能越界,与
'全部动作钉死在一个工作文件夹 root 内'冲突.五件工具全部把路径 ``resolve()`` 后判在
root 内,越界当场拒绝(``out-of-root``),相对路径以 root 为基准.

root 内还有一层**权限规则**(:mod:`dsb.permissions`,#89):按操作分类,最后一条命中的
规则赢,默认拒读写 ``mcp.json`` 与 ``.env`` 系文件,写/改另拒 ``.git/``.原先 ``.git/``
是写死在代码里的一条特例,现已收进那张表.

模块自己一件事:路径沙箱,权限规则与五件工具的**纯逻辑**(对 ``root: Path`` 的函数),
与 MCP 信封解耦.``work_tools(root)`` 是唯一的薄适配层,把纯函数包成
``参数 -> (载荷, 这算不算失败)`` 的处理器(见 :class:`dsb.mcp.Tool`).dsb 只在
:func:`dsb.server.build_tools` 一处挂上它--将来换实现或挪进程,只动那一行.

不依赖 :mod:`dsb.gateway` / :mod:`dsb.server` / 网络;只 import 标准库,``dsb.config``
(root 解析)与 ``dsb.mcp``(注册形状).工具的失败与慢不在本模块留痕--:class:`dsb.mcp.McpService`
统一记一笔 ``tool-fail`` / ``tool-slow``(只留工具名与耗时,不带正文,ADR-0004).
"""

from __future__ import annotations

import multiprocessing
import os
import re
import signal
import threading
import unicodedata
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from dsb.config import env_value, find_dotenv, repo_root, resolve_config_path
from dsb.mcp import Tool
from dsb.permissions import Operation, is_allowed

#: 工作文件夹 root 的配置键:进程环境变量优先,其次 ``.env``,最后本仓根.
WORK_ROOT_ENV_KEY = "DSB_WORK_ROOT"

#: 上限(保护对话与前程):read 的翻页与单次预算,ls 列数,grep 命中数,单行长度,
#: 参与 grep 的文件大小.
#:
#: ``read`` 从"超长就砍一刀"改成**按行翻页**(旧 0010):原来一次 ``read`` 交出 16000 字,
#: 而扩展侧一轮只放 2000 字进对话,模型看到 12%,**且没有任何办法看到其余部分**--再读一遍
#: 拿到的还是开头那几个字.翻页之后上限分成四个各管一件事的数,而不是一个总数.
WORK_READ_PAGE_LINES = 200
WORK_READ_MAX_LINES = 2_000
WORK_READ_LINE_LIMIT = 500
#: 一页的**总量**(行号、行与行之间的换行、末尾那句脚注,全算在内,旧 0010):它与扩展
#: 那道 ``MAX_RESULT_CHARS`` 同数,所以一页能原样进对话--多一个字都会被扩展从尾巴上截掉,
#: 而截掉的正是脚注(``offset`` 的唯一来源).
WORK_READ_BYTES = 16_000
WORK_LIST_LIMIT = 500
WORK_GREP_LIMIT = 200
#: ``grep`` 的墙钟(旧 0010):模式是模型给的,嵌套量词叠上一行几十万字能指数回溯.请求跑在
#: ``ThreadingHTTPServer`` 的工作线程里,而 ``re`` 的指数回溯**攥着 GIL**--留在本进程里跑,
#: 整个中继(连 ``ping`` 一起)都冻住,而且是装不回来的(2026-10-20 实测).于是这一趟进
#: **子进程**跑,墙钟由父进程收(见 :func:`_grep_in_child`):过线只收掉那个搜索,回一个
#: 能让模型改写的码,而不是把工具面一起带走.给得比"正常那趟"宽得多:本仓上 ``ERROR_``
#: 那种模式跑完要 3.5s,早已越过 ``dsb.log.SLOW_MS`` 那道水印.
WORK_GREP_DEADLINE = 20.0
WORK_LINE_LIMIT = 500
WORK_FILE_LIMIT = 1_000_000
#: 探二进制时看的前缀长度:首块里出现 ``\x00`` 就当二进制,跳过.
WORK_BINARY_PROBE = 8_192
#: **整条结果**的最后一道闸(旧 0010 记着的那个缺口):上面那些数各管一维(页行数 /
#: 页字节 / 单行 / 件数 / 命中数),没有谁管"一整条有多大"--500 个长名字的目录项、
#: 200 条各 500 字的命中,每一维都没超限,合起来能把十几万字灌进内存、storage 与对话.
#: 列与搜的出口过同一道(照 pi 的 ``truncateHead`` 口径):超了只砍在行边界上(半行
#: 比没有更坏),末行留一句"接着怎么办",而不是网关那句"已截断:原文 N 字"--模型拿着
#: 那句什么都做不了.与 ``read`` 的一页预算同数:一条结果 = 一页(那边归
#: :data:`WORK_READ_BYTES` 管,页预算就是它的总量闸).**末句也占这笔额度**(旧 0010):
#: 不算它,整条会越过扩展那道 16,000,被截掉的正是"怎么续"那句.
WORK_RESULT_CHARS = 16_000

#: 工具载荷码册子(与 gateway 的三码,mcp.py 的 JSON-RPC 码分属三套,不混).
ERROR_OUT_OF_ROOT = "out-of-root"
ERROR_BAD_PATH = "bad-path"
ERROR_PROTECTED = "protected-path"
ERROR_BAD_RANGE = "bad-range"
ERROR_NOT_FOUND = "not-found"
ERROR_NOT_A_FILE = "not-a-file"
ERROR_NOT_A_DIRECTORY = "not-a-directory"
ERROR_EDIT_NO_MATCH = "edit-no-match"
ERROR_EDIT_NOT_UNIQUE = "edit-not-unique"
ERROR_BAD_REGEX = "bad-regex"
ERROR_PATTERN_TOO_SLOW = "pattern-too-slow"
ERROR_IO_FAILED = "io-failed"

#: 失败回执被 :func:`cap_result` 砍掉之后给模型的那一步:``detail`` 是参数回显, 变小 =
#: 把参数改短(与 ``ls`` / ``grep`` 各自的 hint 同一条口径).
ERROR_HINT = "把参数改短或改窄再试"

#: 只写不读的护栏:``<root>/.git`` 之下(含 ``.git`` 本身,worktree 里 ``.git`` 是文件也算).
#: #89 起它是 :data:`dsb.permissions.DEFAULT_RULES` 里 ``edit`` 那份表的一条规则
#: (``.git`` / ``.git/*`` deny),这里只留字面量给遍历时裁目录用.
PROTECTED_DIR = ".git"

#: dsb 实际会去读的那两个本机配置文件(#89):默认在仓根,但都能被配置改到别处.
#: 保护的是**真实生效的那两个文件**,不只是名字--落在 root 内它们同样读写都拒.
#: ``DSB_MCP_CONFIG`` 指向的中继配置由 :mod:`dsb.gateway` 解析,``.env`` 由
#: :func:`dsb.config.env_value` 读(root 解析也走它).
MCP_CONFIG_ENV_KEY = "DSB_MCP_CONFIG"
ENV_FILE_NAME = ".env"

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
    """``resolved`` 的**根相对 POSIX 路径**(权限规则比对的输入);不在 root 内回 ``None``.

    两侧现各解析一次:``resolved`` 正常已由 :func:`resolve_in_root` 归一,这里再兜一层,
    免得调用方递来未归一的路径(``/var`` 与 ``/private/var`` 这类)时护栏**静默放行**.
    """
    try:
        relative = resolved.resolve().relative_to(root.resolve())
    except (ValueError, OSError, RuntimeError):
        return None
    return relative.as_posix()


def _effective_sensitive(root: Path) -> tuple[Path, ...]:
    """dsb **真实生效**的那两个本机配置文件的绝对路径(可能不在 root 内,不做拦截).

    ``mcp.json`` 直接用 :func:`dsb.server.resolve_config_path`--那才是真正决定中继读哪
    个文件的函数(含 cwd 兜底),另抄一份只会漂.``.env`` 用
    :func:`dsb.config.find_dotenv`(先当前目录,再仓根).

    两者被配置改到别处时,护栏跟过去:**保护的是那两个真文件,不只是'叫这个名字的
    文件'**.
    """
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
    except OSError:
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
        return False
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
    """``resolved`` 是否在 ``<root>/.git`` 之下(含 ``.git`` 本身).读侧不拦,只写/改拦.

    #89 之后是 :func:`is_protected` 的一个薄壳(走 ``edit`` 那份规则表),留这个名字是
    因为既有测试与遍历裁剪都在用.
    """
    return (
        is_protected(root, resolved, "edit")
        and root_relative(root, resolved) is not None
        and root_relative(root, resolved).split("/")[0] == PROTECTED_DIR
    )


def _require_root(root: Path) -> None:
    if not root.is_dir():
        raise WorkError(ERROR_BAD_PATH, detail=f"工作目录不存在:{root}")


def _relative_to_root(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root.resolve()))
    except ValueError:
        return str(path)


def _units(text: str) -> int:
    """这段正文在**扩展侧**量出来多长:dsb 与扩展必须用同一种单位(旧 0010).

    JS 的 ``.length`` 数的是 UTF-16 单元(星平面字--emoji 之类--算两个),Python 的
    :func:`len` 数的是码点(算一个).纯 CJK 与 ASCII 下两个数相等,所以以前没露过;
    正文里出现星平面字时,同一个串在扩展侧量出来更大,于是"dsb 交出的每一条结果都原样
    进对话"那条保证会破,被截掉的正是脚注或"怎么续"那句.两边同数 = 这里按扩展的单位量.

    ``surrogatepass``:文件是按 ``surrogateescape`` 读进来的(:func:`read_text`),非法字节
    在串里是孤立代理项,默认的 utf-16 编码器见到它会抛.
    """
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def cap_result(text: str, hint: str) -> str:
    """整条结果的闸:超 :data:`WORK_RESULT_CHARS` 字就砍,末行说清接着怎么办.

    **任何正文进来,出门的那一整条(连末句)都 <=** :data:`WORK_RESULT_CHARS`--末句不算
    进去就会越过扩展那道同数的闸,被截掉的正是"怎么续"那句(旧 0010).

    砍的次序:尽量砍在行边界上(半行比没有更坏--模型会把半行当成一整行,与
    :func:`render_page` 标单行的理由同一条);**第一行自己就超预算**时在行内砍--失败回执
    就是这一种:``detail`` 里回显的往往是模型自己写进来的模式串或路径,一行能几十万字.

    ``hint`` 是砍掉之后该走的那一步(换个更小的目录 / 收窄模式),由调用方给--闸只
    知道"太大了",不知道"怎么变小".
    """
    if _units(text) <= WORK_RESULT_CHARS:
        return text
    rows = splitlines(text)
    # 末句也占这笔额度:不算它,整条(正文 + 末句)就会越过扩展那道 16000,被扩展从
    # 尾巴上截--截掉的正好是"怎么续"(旧 0010).
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
    """第一行一整个放不下:在行内砍,末句说清这一行被砍在哪(旧 0010).

    末句里**不带**"给了前 N 字"--那会让末句长度依赖砍到哪,于是要循环;``原文 N 字``
    就够了,模型自己数得出来.预算小到连末句都放不下时**只给这一行**:说一句"已截断"而
    其实没砍,比不说更坏.
    """
    note = f"\n...(这一行超 {WORK_RESULT_CHARS} 字,已截断:原文 {_units(row)} 字;{hint})"
    if _units(note) >= WORK_RESULT_CHARS:
        return row
    return _cut_units(row, WORK_RESULT_CHARS - _units(note)) + note


def _cut_units(text: str, budget: int) -> str:
    """取开头一段,长度不超过 ``budget`` 个 UTF-16 单元(与 :func:`_units` 同一把尺).

    星平面字在扩展侧占两个单元,所以按码点取 ``budget`` 个字之后要把多出来的单元退掉.
    """
    cut = text[:budget]
    drop = _units(cut) - budget
    while drop > 0 and cut:
        drop -= 2 if ord(cut[-1]) > 0xFFFF else 1
        cut = cut[:-1]
    return cut


def _result_note(kept: int, total: int, hint: str) -> str:
    """截断末句:说清给了多少、砍了多少,以及接着该怎么办."""
    return f"...(整条超 {WORK_RESULT_CHARS} 字,已截断:给了前 {kept} 行 / 共 {total} 行;{hint})"


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
    listing = "\n".join(lines) if lines else "(空)"
    return cap_result(listing, "换个更小的目录再列")


def splitlines(content: str) -> list[str]:
    """正文 → 行.

    **不以换行结尾的文件不多算一行**:``"a\\nb\\n"`` 是两行(第二行是空的,但以换行结束
    就没有第三行),而 ``"a\\nb"`` 也是两行.所以去掉结尾那个换行再切--否则脚注里那个
    总行数会比文件真实的行数多 1,而模型会照抄那个数(真机:它把 624 行的文件报成 625 行).
    中间的空行照旧是行(``"a\\n\\nb"`` 是三行).
    """
    return content.removesuffix("\n").split("\n") if content else []


def render_page(lines: list[str], offset: int, limit: int) -> str:
    """一页行 → 带行号的正文 + 一句脚注(纯函数,判定全在这里,旧 0010).

    **整页(含行号、换行、脚注)不超过 :data:`WORK_READ_BYTES`**:它正是扩展那道
    ``MAX_RESULT_CHARS``,越线就会被扩展从尾巴上截掉,而截掉的正是脚注(旧 0010).

    三种脚注各自说清'读到哪'与'接着怎么读',而**只有一种真的有下一读**:

    - 文件读完了 → 说总行数,不编下一步;
    - 页按行数到头,文件还有 → 给 ``offset=``;
    - 页被单次字节预算砍在半路 → 先说被砍(模型要知道这一页本身不完整),
      再说 ``offset=``.

    单行超长另标一行(``...(本行超 N 字)``):静默截断会让模型以为那就是整行.
    """
    total = len(lines)
    if offset > total:
        return f"(空:offset={offset} 超出文件总行数 {total})"
    start = offset
    window = lines[start - 1 : start - 1 + limit]
    out: list[str] = []
    used = 0
    capped = False
    for step, text in enumerate(window):
        number = start + step
        row = text if len(text) <= WORK_READ_LINE_LIMIT else text[:WORK_READ_LINE_LIMIT]
        marked = len(row) != len(text)
        body = f"{number}: {row}" + (f"...(本行超 {WORK_READ_LINE_LIMIT} 字)" if marked else "")
        # 行与行之间的换行、末尾那句脚注都占页预算:不算它们,一页(正文 + 脚注)就会越过
        # 扩展那道 16000,被扩展从尾巴上截--截掉的正好是脚注(``offset`` 的唯一来源).
        cost = _units(body) + (1 if out else 0) + 1 + _page_footer_room(start, number, total)
        # 一行都放不下时**放它进去**(哪怕超预算)并说明被砍--空页对模型最没用,
        # 它拿不到任何内容,连翻到哪都不知道.
        if out and used + cost > WORK_READ_BYTES:
            capped = True
            break
        used += _units(body) + (1 if out else 0)
        out.append(body)
    end = start + len(out) - 1
    rows = "\n".join(out)
    return f"{rows}\n{_page_footer(start, end, total, capped)}"


def _page_footer_room(start: int, end: int, total: int) -> int:
    """这一页脚注的保守长度(取最长那一态):页预算要连它一起算(旧 0010)."""
    return max(
        _units(_page_footer(start, end, total, capped=True)),
        _units(_page_footer(start, end, total, capped=False)),
    )


def _page_footer(start: int, end: int, total: int, capped: bool) -> str:
    """这一页的脚注:三态各自说清读到哪,**只有真有下一读的那种才给 ``offset=``**."""
    if end >= total and not capped:
        return f"(文件读完:共 {total} 行)"
    where = f"第 {start}-{end} 行 / 共 {total} 行"
    if capped:
        return f"(字节预算截断,{where},接着读:offset={end + 1})"
    return f"({where},接着读:offset={end + 1})"


def read_text(root: Path, raw: str, offset: int = 1, limit: int | None = None) -> str:
    """``read``:读 root 内一个文件的一页(带行号),脚注写明读到哪,接着怎么读.

    受 ``read`` 那份规则表管(#89):``mcp.json`` 与 ``.env`` 系文件读不出来--读出来的
    内容会**随回灌进对话,也就是发给站点**.

    翻页与三个上限见 :data:`WORK_READ_PAGE_LINES` 那组(旧 0010).**逐行给,带行号**:
    模型拿到的是'第 121-200 行 / 共 843 行,接着读:offset=201',而不是一句'已截断'
    --后者它拿着什么都做不了,只能重读再被截一次.
    """
    _require_root(root)
    path = resolve_in_root(root, raw)
    if is_protected(root, path, "read"):
        raise WorkError(ERROR_PROTECTED, detail=f"路径 {raw}(读侧受保护)")
    if not path.exists():
        raise WorkError(ERROR_NOT_FOUND, detail=f"路径 {raw}")
    if not path.is_file():
        raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {raw}")
    if offset < 1:
        raise WorkError(ERROR_BAD_RANGE, detail=f"offset={offset}(行号从 1 起)")
    page = WORK_READ_PAGE_LINES if limit is None else limit
    if page < 1:
        raise WorkError(ERROR_BAD_RANGE, detail=f"limit={page}(至少 1 行)")
    if page > WORK_READ_MAX_LINES:
        page = WORK_READ_MAX_LINES
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}(不是文本)") from exc
    except OSError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    return render_page(splitlines(content), offset, page)


def write_text(root: Path, raw: str, content: str) -> int:
    """``write``:在 root 内新建/覆盖文件(自动建父目录),回写入的字节数.

    受 ``edit`` 那份规则表管(#89):``.git/`` 与 ``mcp.json`` / ``.env`` 系文件写不进去.
    """
    _require_root(root)
    path = resolve_in_root(root, raw)
    if is_protected(root, path, "edit"):
        raise WorkError(ERROR_PROTECTED, detail=f"路径 {raw}")
    if path.is_dir():
        raise WorkError(ERROR_NOT_A_FILE, detail=f"路径 {raw}")
    try:
        data = content.encode("utf-8")
    except UnicodeEncodeError as exc:
        # 孤立代理字符(JSON 里的 \ud800:模型偶尔写坏的半个 emoji 转义)落不成 UTF-8.
        # 必须先挡在 open 之前--write_text 是"先按 w 截断,再编码",空了才抛.
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}(正文不是文本)") from exc
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    return len(data)


def edit_text(root: Path, raw: str, old_string: str, new_string: str) -> int:
    """``edit``:``old_string`` 在文件里**唯一命中**才替换;0 处/多处回错码且文件不变.

    受 ``edit`` 那份规则表管(#89),与 :func:`write_text` 同一份表.
    """
    _require_root(root)
    path = resolve_in_root(root, raw)
    if is_protected(root, path, "edit"):
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
    updated = content.replace(old_string, new_string, 1)
    try:
        updated.encode("utf-8")
    except UnicodeEncodeError as exc:
        # 同上:替换后的正文落不成 UTF-8 时别动文件(截断在前,编码在后).
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}(正文不是文本)") from exc
    try:
        path.write_text(updated, encoding="utf-8")
    except OSError as exc:
        raise WorkError(ERROR_IO_FAILED, detail=f"路径 {raw}") from exc
    return 1


def _walk_files(base: Path) -> Iterator[Path]:
    """``base`` 下的文件(不跟符号链接目录,遍历时跳过 ``.git``--纯为省时间).

    内容侧的拦截不在这里:``grep`` 逐个文件套 ``read`` 规则表(#89),那才是决定
    '读不读'的地方.
    """
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name != PROTECTED_DIR)
        for name in sorted(filenames):
            yield Path(dirpath) / name


@contextmanager
def _deadline(seconds: float, what: str) -> Iterator[None]:
    """到点抛 :data:`ERROR_PATTERN_TOO_SLOW`.

    ``re`` 的内部循环会周期性查信号,所以指数回溯**真的**能被这一下打断(实测:
    40 个 ``a`` 后面挂 ``(a+)+b``,不打就再也回不来).装不上就**不装**--``signal``
    只能在主线程里装,少一道闸好过在错误的地方抛异常.

    这一道现在装在**跑扫描的子进程**里(那里是单线程,装得上);发起请求的那个线程里
    永远装不上,所以父进程另收一道墙钟兜着,见 :func:`_grep_in_child`.
    """
    main = threading.current_thread() is threading.main_thread()
    if not hasattr(signal, "setitimer") or not main:  # pragma: no cover - 平台/线程差异
        yield
        return

    def fire(*_args: object) -> None:
        raise WorkError(ERROR_PATTERN_TOO_SLOW, detail=what)

    previous = signal.signal(signal.SIGALRM, fire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _grep_child(send: Any, root: Path, pattern: str, raw: str, seconds: float, what: str) -> None:
    """子进程那一半:跑一趟,结果或错误码从管道回去.

    孩子**自己**也装一道墙钟(:func:`_deadline`):子进程是单线程的,``signal`` 在这儿装得上.
    父进程那道 ``kill`` 是外层;这道是兜住"父进程被人收走"的情形--否则那个爆炸的搜索
    会变成没人管的孤儿,一直转下去.
    """
    try:
        try:
            with _deadline(seconds, what):
                text = _grep_scan(root, pattern, raw)
            send.send(("ok", text))
        except WorkError as error:
            send.send(("fail", error.code, error.detail))
        except BaseException:  # noqa: BLE001 - 孩子里漏出来的任何东西都折成一个码
            send.send(("fail", ERROR_IO_FAILED, None))
    finally:
        send.close()


def _grep_in_child(root: Path, pattern: str, raw: str, seconds: float, what: str) -> str:
    """扫一趟,墙钟到点**收掉这个子进程**.

    为什么非得进子进程:请求跑在 ``ThreadingHTTPServer`` 的工作线程里,``signal`` 只在主线程
    装得上,而 ``re`` 的指数回溯攥着 GIL--留在本进程里跑,``ping`` 和其余工具一起冻住
    (2026-10-20 实测:并发的 ``ping`` 3s 超时,``grep`` 永不回话).墙钟由父进程收,
    与哪个线程发起的无关.

    平台没有 ``fork``(Windows)时装不上这道闸,退回本进程直跑.
    """
    # shortcut: 从多线程进程 fork, 孩子可能撞上别的线程正拿着的锁僵住(到点被 kill, 这一趟
    # 白回一个 pattern-too-slow); 真成问题时换成常驻的单线程搜索子进程.
    try:
        context = multiprocessing.get_context("fork")
    except ValueError:  # pragma: no cover - 平台差异(Windows)
        return _grep_scan(root, pattern, raw)
    receive, send = context.Pipe(duplex=False)
    child = context.Process(target=_grep_child, args=(send, root, pattern, raw, seconds, what))
    child.daemon = True
    child.start()
    send.close()
    try:
        if not receive.poll(seconds):
            raise WorkError(ERROR_PATTERN_TOO_SLOW, detail=what)
        try:
            outcome = receive.recv()
        except EOFError as exc:  # 孩子没回话就走了:按一次失败的搜索收场
            raise WorkError(ERROR_IO_FAILED, detail=what) from exc
    finally:
        if child.is_alive():
            child.kill()
        child.join()
        receive.close()
    if outcome[0] == "ok":
        return str(outcome[1])
    raise WorkError(str(outcome[1]), detail=outcome[2])


def grep_tree(root: Path, pattern: str, raw: str = ".") -> str:
    """``grep``:在 root 内按正则搜文本行,回 ``相对路径:行号: 行``.

    有上限,跳二进制;**对每个文件套 ``read`` 那份规则表**,命中 deny 就跳过(#89)--
    ``mcp.json`` / ``.env`` 的内容**一个字都不进结果**,哪怕模式正好命中里面的某行.

    ``ls`` 仍如实列出这些文件的名字(只拦内容,不隐藏存在,与 opencode 一致).

    整趟(编译 + 遍历 + 逐行匹配)在**子进程**里跑,父进程只等 ``WORK_GREP_DEADLINE``
    那道墙钟(:func:`_grep_in_child`,旧 0010 + 2026-10-20).
    """
    _require_root(root)
    what = (
        f"模式 {pattern!r} 未在 {WORK_GREP_DEADLINE:g}s 内搜完(换简单点的写法,或指定 path 缩小范围)"
    )
    return _grep_in_child(root, pattern, raw, WORK_GREP_DEADLINE, what)


def _grep_scan(root: Path, pattern: str, raw: str) -> str:
    """真搜的那一趟(单独成函数,好让整个扫描躺在墙钟里)."""
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
        if not _inside(root_real, resolved) or is_protected(root, resolved, "read"):
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
        for number, row in enumerate(splitlines(text), start=1):
            # 行号与 `read` 同一条口径(只认 `\n`,见 `splitlines`):模型照这里的行号去 `read`
            # 得落在同一行. 行尾的 `\r` 照旧摘掉--CRLF 文件里 `模式$` 仍要命中.
            line = row.removesuffix("\r")
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
    found = "\n".join(hits) if hits else "(无命中)"
    return cap_result(found, "收窄模式,或指定 path 分几次搜")


def _wrap(action: Callable[[], str]) -> tuple[Payload, bool]:
    """纯函数 → 处理器载荷:``WorkError`` 折成 ``code(detail)`` 的失败正文.

    成功与失败走**同一道**闸(:func:`cap_result`):失败串不过闸的话,底下只剩 JSON-RPC
    那一层的 ``MAX_BODY_BYTES = 256 * 1024`` 兜着,而 ``detail`` 里回显的串是模型写进来的,
    可以很长(旧 0010).
    """
    try:
        return {"text": action()}, False
    except WorkError as error:
        body = error.code if error.detail is None else f"{error.code}({error.detail})"
        return {"text": cap_result(body, ERROR_HINT)}, True


def _bad_path(detail: str) -> tuple[Payload, bool]:
    return {"text": cap_result(f"{ERROR_BAD_PATH}({detail})", ERROR_HINT)}, True


def work_tools(root: Path) -> list[Tool]:
    """五件工作工具:把纯函数包成 :class:`dsb.mcp.Tool`(相对路径以 ``root`` 为基准)."""

    def ls_handler(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        raw = arguments.get("path")
        return _wrap(lambda: list_dir(root, "." if raw is None else raw))

    def read_handler(arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        raw = arguments.get("path")
        if not isinstance(raw, str) or not raw.strip():
            return _bad_path("缺少 path")
        offset = arguments.get("offset", 1)
        if not isinstance(offset, int) or isinstance(offset, bool):
            return _bad_path("offset 必须是整数")
        page = arguments.get("limit")
        if page is not None and (not isinstance(page, int) or isinstance(page, bool)):
            return _bad_path("limit 必须是整数")
        return _wrap(lambda: read_text(root, raw, offset, page))

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
            description=(
                "[工作目录] 读工作目录内一个文件的一页,逐行带行号."
                "offset 是起始行号(从 1 起,默认 1),limit 是读多少行(默认 200)."
                "正文末尾有脚注写明读到哪,接着读用什么 offset--文件长就翻页,别改 offset 重读."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "工作目录内的文件路径."},
                    "offset": {
                        "type": "integer",
                        "description": "起始行号,从 1 起;默认 1(按脚注给的 offset 接着读).",
                    },
                    "limit": {
                        "type": "integer",
                        "description": (
                            f"读多少行;默认 {WORK_READ_PAGE_LINES},最多 {WORK_READ_MAX_LINES}."
                        ),
                    },
                },
                "required": ["path"],
            },
            handler=read_handler,
        ),
        Tool(
            name="grep",
            description=(
                "[工作目录] 在工作目录内按正则搜索文本行,回 相对路径:行号: 行. "
                "正则按 Python `re` 语法. 模式太费(嵌套量词 + 超长行)会中止,换简单点的写法."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Python `re` 语法的正则."},
                    "path": {
                        "type": "string",
                        "description": "工作目录内的文件或目录,缺省整个工作目录.",
                    },
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
    "ERROR_BAD_RANGE",
    "ERROR_BAD_REGEX",
    "ERROR_EDIT_NO_MATCH",
    "ERROR_EDIT_NOT_UNIQUE",
    "ERROR_IO_FAILED",
    "ERROR_NOT_A_DIRECTORY",
    "ERROR_NOT_A_FILE",
    "ERROR_NOT_FOUND",
    "ERROR_OUT_OF_ROOT",
    "ERROR_PATTERN_TOO_SLOW",
    "ERROR_PROTECTED",
    "ENV_FILE_NAME",
    "MCP_CONFIG_ENV_KEY",
    "PROTECTED_DIR",
    "is_protected",
    "root_relative",
    "WORK_FILE_LIMIT",
    "WORK_GREP_DEADLINE",
    "WORK_GREP_LIMIT",
    "WORK_LINE_LIMIT",
    "WORK_LIST_LIMIT",
    "WORK_READ_BYTES",
    "WORK_READ_LINE_LIMIT",
    "WORK_READ_MAX_LINES",
    "WORK_READ_PAGE_LINES",
    "WORK_ROOT_ENV_KEY",
    "WorkError",
    "edit_text",
    "grep_tree",
    "list_dir",
    "protected_git",
    "read_text",
    "render_page",
    "resolve_in_root",
    "splitlines",
    "resolve_work_root",
    "work_tools",
    "write_text",
]
