#!/usr/bin/env python3
"""无人值守: 盯住指定的 opencode 会话, 闲下来的那一下替用户发一句催办.

**为什么要有它**: 无人值守跑 opencode 时, 会话答完一轮就停在空闲等用户回话,
没人接就干耗. 这个脚本轮询服务端, 发现会话从"跑着"变成"闲着"就补一句
"无人值守,继续推进", 把它推着往前走.

**闲的判据是两条腿取或**: `GET /api/session/active` 列出**正在跑**的会话(接口自己写的:
"Sessions absent from the result are inactive"), 但它只认**这个**服务进程手里的活 --
被别的进程推着的会话它看不见; 补一条落库的: `time.idle` 是"最近一次闲下来"写下的戳,
一轮里 `time.updated` 会越过后它. 两条都指向闲才算闲, 判据朝"跑着"偏(把跑着的会话
误判成闲 = 往生成里插嘴, 比漏一拍催办难收拾). 不拿 `time.idle` **单独**判: 从没跑过的
新会话没有这一项, 而且它的口径没有文档, 是看读数反推的, 单独当判据等于把反推当契约.

**催过就不重复催**: 光看"闲"会每拍灌一句. 所以还记一条**基线** -- 上一句催办
那一条消息的 `time.created`. 只在会话的 `time.updated` **越过**基线时才再催:
越过说明会话真动过(那一轮跑完了), 没越过说明催了没开工, 再催也是灌水.
基线取 prompt 接口回的那条消息自己的时间戳, 用服务端的钟, 不掺本地时间 --
本地钟与服务端对不齐的话, 要么漏催, 要么同一轮里连催.

**为什么走 `opencode api` 而不是直连 HTTP**: 找服务与鉴权都归它管, 这里只解码形状.
失败的形状值得记一笔: 出错时它把状态行写 stderr(`HTTP 404 Not Found`), 错误体写
stdout(JSON, 带 `_tag`), 而且**退出码非 0** -- 所以判成功看退出码, 不看 stdout
解不解得开. 有两档 `_tag` 不当故障, 当"这个会话不用盯了": 会话没了(或 ID 打错,
服务端分不出这两者)是 `SessionNotFoundError`, 工作目录被改名或移走是
`LocationNotFoundError`. 这两样等一拍都不会自己好, 当故障就会一直重试.

用法:
  uv run scripts/unattended.py                            # 不给 -s 就列顶层会话, 从这儿取 ID
  uv run scripts/unattended.py -s ses_xxx                 # 盯一个, 30s 一拍
  uv run scripts/unattended.py -s ses_xxx -s ses_yyy      # 盯多个
  uv run scripts/unattended.py -s ses_xxx --interval 10   # 改拍子
  uv run scripts/unattended.py -s ses_xxx --dry-run       # 只看会催谁, 不发
  uv run scripts/unattended.py -s ses_xxx --once          # 只扫一拍就退

会话 ID 是 `ses_` 开头那串, 列表里第一列就是它.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

TAG = "[unattended]"
DEFAULT_INTERVAL_S = 30.0
DEFAULT_LIST_LIMIT = 3
DEFAULT_TEXT = "自主行动,继续推进"

#: 这两档错说明"这个会话不用再盯了": 前者是会话没了(ID 打错也是这个形状), 后者是
#: 它的工作目录不在了(目录被改名或移走). 都不是等一拍就能好的, 当故障会一直重试.
UNREACHABLE = frozenset({"SessionNotFoundError", "LocationNotFoundError"})


class OpencodeError(RuntimeError):
    """`opencode api` 没跑成; `tag` 是错误体里的 `_tag`(解得开才有)."""

    def __init__(self, message: str, tag: str | None = None) -> None:
        super().__init__(message)
        self.tag = tag


@dataclass(frozen=True)
class SessionView:
    """会话某一拍的读数."""

    session_id: str
    running: bool
    updated: float


def view_of(session_id: str, info: dict, active: Iterable[str]) -> SessionView:
    time = info["time"]
    return SessionView(
        session_id=session_id,
        running=session_id in active or still_working(time),
        updated=float(time["updated"]),
    )


def still_working(time: dict) -> bool:
    """落库的那条腿: `time.idle` 是"最近一次闲下来"写下的戳, 一轮里 `updated` 会越过后它.

    两个信号取或, 各盖一片: `active` 是**当时**的("此刻这个进程里有没有活"), 但它只认
    本服务进程手里的活 -- 会话要是被别的进程推着(`--standalone` 起的那种), 这边就看不见;
    而 `time` 是落库的, 跨进程看得见. 反过来, 从没跑过的新会话没有 `idle` 这一项,
    那个坑只能靠 `active` 填. 判据朝"跑着"偏: 把跑着的会话误判成闲 = 往生成里插嘴,
    比漏一拍催办难收拾.
    """
    idle = time.get("idle")
    return idle is not None and float(time["updated"]) > float(idle)


def should_nudge(view: SessionView, baseline: float | None) -> bool:
    if view.running:
        return False
    return baseline is None or view.updated > baseline


def session_line(info: dict, active: Iterable[str]) -> str:
    """列表里的一行: `ID  状态  最后动过  标题` -- 取 ID 与挑会话都靠这一眼."""
    state = "跑着" if info["id"] in active or still_working(info["time"]) else "闲着"
    stamp = datetime.fromtimestamp(float(info["time"]["updated"]) / 1000).strftime("%m-%d %H:%M")
    return f"{info['id']}  {state}  {stamp}  {flat_title(info.get('title'))}"


def flat_title(title: object, limit: int = 40) -> str:
    """标题压成一行: 换行与制表符会把表格拆散, 长标题截断留个记号."""
    text = " ".join(str(title or "").split()) or "(没标题)"
    return text if len(text) <= limit else text[: limit - 3] + "..."


def project_at(cwd: str, projects: Sequence[dict]) -> str | None:
    """cwd 落在哪个项目里: 取最深的那个祖先 -- 项目的 `canonical` 是仓库根, 越深越具体.

    不按 `directory=` 过滤: 那个要**精确**命中会话的 location 目录(在仓库子目录里跑就
    一条都列不出来, 实测), 而会话的 location 是它被建起来时的那个目录. 按项目过滤则
    只要 cwd 在仓库里就行.
    """
    here = Path(cwd).resolve()
    best: tuple[int, str] | None = None
    for project in projects:
        root = Path(project["canonical"]).resolve()
        if here != root and root not in here.parents:
            continue
        depth = len(root.parts)
        if best is None or depth > best[0]:
            best = (depth, str(project["id"]))
    return best[1] if best else None


class Client(Protocol):
    def active(self) -> set[str]: ...

    def projects(self) -> list[dict]: ...

    def sessions(self, limit: int, project: str | None) -> list[dict]: ...

    def info(self, session_id: str) -> dict | None: ...

    def prompt(self, session_id: str, text: str) -> float: ...


class OpencodeClient:
    """把 `opencode api` 的几次调用包成方法; 形状不对就抛 `OpencodeError`."""

    def __init__(self, command: Sequence[str] = ("opencode", "api"), timeout: float = 30.0) -> None:
        self._command = tuple(command)
        self._timeout = timeout

    def active(self) -> set[str]:
        return set(self._object(["get", "/api/session/active"])["data"])

    def projects(self) -> list[dict]:
        body = self._call(["get", "/api/project"])
        if not isinstance(body, list):
            raise OpencodeError(f"/api/project 回的不是数组: {str(body)[:100]!r}")
        return list(body)

    def sessions(self, limit: int, project: str | None = None) -> list[dict]:
        query = f"limit={limit}&parentID=null"
        if project:
            query += f"&project={project}"
        return list(self._object(["get", f"/api/session?{query}"])["data"])

    def info(self, session_id: str) -> dict | None:
        try:
            body = self._object(["get", f"/api/session/{session_id}"])
        except OpencodeError as error:
            if error.tag in UNREACHABLE:
                return None
            raise
        return body["data"]

    def prompt(self, session_id: str, text: str) -> float:
        body = self._object(
            ["post", f"/api/session/{session_id}/prompt", "--data", json.dumps({"text": text})]
        )
        return float(body["data"]["time"]["created"])

    def _object(self, args: Sequence[str]) -> dict:
        body = self._call(args)
        if not isinstance(body, dict):
            raise OpencodeError(f"回的 JSON 不是对象: {str(body)[:100]!r}")
        return body

    def _call(self, args: Sequence[str]) -> object:
        try:
            done = subprocess.run(
                [*self._command, *args],
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
            )
        except FileNotFoundError as error:
            raise OpencodeError(f"跑不动 `{self._command[0]}`: {error}") from error
        except subprocess.TimeoutExpired as error:
            raise OpencodeError(f"`{' '.join(args)}` 超时({self._timeout:g}s)") from error
        if done.returncode != 0:
            raise OpencodeError(_failure(done), _tag_of(done.stdout))
        try:
            return json.loads(done.stdout)
        except json.JSONDecodeError as error:
            raise OpencodeError(f"回的不是 JSON: {done.stdout[:200]!r}") from error


def _tag_of(body: str) -> str | None:
    try:
        decoded = json.loads(body)
    except json.JSONDecodeError:
        return None
    return decoded.get("_tag") if isinstance(decoded, dict) else None


def _failure(done: subprocess.CompletedProcess[str]) -> str:
    lines = done.stderr.strip().splitlines()
    return lines[-1] if lines else f"退出码 {done.returncode}"


class Follower:
    """盯一组会话: 每拍读一遍, 读到位就催."""

    def __init__(
        self,
        client: Client,
        sessions: Sequence[str],
        text: str,
        *,
        dry_run: bool = False,
        out: Callable[[str], None] = print,
    ) -> None:
        self._client = client
        self._text = text
        self._dry_run = dry_run
        self._out = out
        self._sessions = list(sessions)
        self._baselines: dict[str, float | None] = dict.fromkeys(sessions)

    @property
    def sessions(self) -> tuple[str, ...]:
        return tuple(self._sessions)

    def tick(self) -> int:
        active = self._client.active()
        nudged = 0
        for session_id in list(self._sessions):
            info = self._client.info(session_id)
            if info is None:
                self._out(f"{TAG} {session_id} 够不着(删了 / ID 不对 / 工作目录不在了), 不再盯")
                self._sessions.remove(session_id)
                del self._baselines[session_id]
                continue
            view = view_of(session_id, info, active)
            if not should_nudge(view, self._baselines[session_id]):
                continue
            if self._dry_run:
                self._out(f"{TAG} {session_id} 闲着, 该催(--dry-run, 没发)")
                self._baselines[session_id] = view.updated
            else:
                self._baselines[session_id] = self._client.prompt(session_id, self._text)
                self._out(f"{TAG} {session_id} 闲着, 已催: {self._text}")
            nudged += 1
        return nudged


def watch(
    follower: Follower,
    interval: float,
    *,
    once: bool = False,
    out: Callable[[str], None] = print,
) -> None:
    """拍到没会话可盯为止; 一拍扫炸了不致命, 记一声接着拍."""
    while follower.sessions:
        try:
            follower.tick()
        except OpencodeError as error:
            out(f"{TAG} 这一拍没扫成({error}), 下一拍再试")
        if once:
            return
        time.sleep(interval)


def list_sessions(client: Client, limit: int, out: Callable[[str], None] = print) -> int:
    """列当前项目的顶层会话, 让用户自己挑 ID 喂给 `-s`.

    两处收窄, 都是实测出来的: 只要顶层(`parentID=null`), 因为子会话是子代理开的,
    催它等于绕开开它的那个会话; 只按当前**项目**过滤, 因为裸的 `/api/session` 会把
    别的项目(连工作目录已经没了的)一起端上来 -- 服务器自己的 location 是 `/Users/co`
    那种上级目录, 靠它筛也不对, 得拿 cwd 去项目表里认领(`project_at`).
    """
    project = project_at(os.getcwd(), client.projects())
    sessions = client.sessions(limit, project)
    if not sessions:
        out(f"{TAG} 这个项目一个会话都没有")
        return 0
    active = client.active()
    scope = "本项目顶层会话" if project else "所有项目的顶层会话(cwd 不在任何项目里)"
    out(f"{TAG} {scope}(新到旧); 盯哪个就把第一列喂给 -s:")
    for info in sessions:
        out(f"  {session_line(info, active)}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="无人值守: 盯住指定的 opencode 会话, 闲着就替用户发一句催办.",
    )
    parser.add_argument(
        "-s",
        "--session",
        dest="sessions",
        action="append",
        metavar="SES",
        help="要盯的会话 ID, 可重复给; 不给就列会话",
    )
    parser.add_argument("--list", action="store_true", help="列会话(不给 -s 时也是这样)")
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIST_LIMIT,
        metavar="N",
        help=f"列会话时最多列几个, 默认 {DEFAULT_LIST_LIMIT}",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_INTERVAL_S,
        metavar="SEC",
        help=f"拍子, 默认 {DEFAULT_INTERVAL_S:g}s",
    )
    parser.add_argument("--text", default=DEFAULT_TEXT, help="催办那句话, 默认 %(default)r")
    parser.add_argument("--dry-run", action="store_true", help="只报该不该催, 不发")
    parser.add_argument("--once", action="store_true", help="只扫一拍就退")
    args = parser.parse_args(argv)

    if args.list or not args.sessions:
        return list_sessions(OpencodeClient(), args.limit)
    if args.interval <= 0:
        parser.error("--interval 得是正的; 0 会变成连着捶服务端")

    follower = Follower(OpencodeClient(), args.sessions, args.text, dry_run=args.dry_run)
    print(
        f"{TAG} 盯 {', '.join(follower.sessions)}, 每 {args.interval:g}s 一拍"
        + (", --dry-run 不发" if args.dry_run else "")
    )
    try:
        watch(follower, args.interval, once=args.once)
    except KeyboardInterrupt:
        print(f"\n{TAG} 收工")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
