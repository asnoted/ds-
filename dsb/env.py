"""``dsb env``:开发与测试环境的一条命令入口.

只做三件"机器能替人做"的事:拉齐依赖、跑两端对拍、报告现状.
浏览器与环境变量那两件人做的事,仍旧归 ``scripts/env-up.sh``--本模块不碰.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from dsb.config import find_dotenv, repo_root
from dsb.gateway import (
    CONNECT_TIMEOUT_ENV_KEY,
    DEFAULT_TOOL_TIMEOUT,
    TOOL_TIMEOUT_ENV_KEY,
    resolve_seconds,
)

#: 扩展侧那道兜底超时的声明点(与 ``tests/test_relay_contract.py`` 对拍同源).
RELAY_TS = repo_root() / "src" / "lib" / "relay.ts"
CALL_TIMEOUT_RE = re.compile(r"MCP_CALL_TIMEOUT_MS\s*=\s*([\d_]+)")

#: ping 日志的候选落点:与 ``scripts/env-up.sh`` 的 ``last_probe_age`` 同一口径.
PROBE_LOG_CANDIDATES = ("/tmp/dsb-relay.log", "/tmp/dsb.log")

#: ``dsb env up`` 顺手跑的三份对拍(快,且就是"两端还对齐着"的判据).
ALIGNMENT_TESTS = (
    "tests/test_relay_contract.py",
    "tests/test_wait_budget.py",
    "tests/test_fixtures.py",
)


def _num(raw: str) -> int:
    return int(raw.replace("_", ""))


def check_timeouts() -> list[str]:
    """两端超时不等式:扩展的 ``CALL`` 必须盖住中继的 ``CONNECT + TOOL``.

    中继自己的两段(握手 + 调用)各跑各的;扩展先 abort,报出来的只有没信息量的
    ``relay-unreachable``,还白扔一次正在跑的调用.这条不等式是那件事的静态防线.
    """
    if not RELAY_TS.is_file():
        return [f"找不到 {RELAY_TS},跳过超时对拍"]
    match = CALL_TIMEOUT_RE.search(RELAY_TS.read_text(encoding="utf-8"))
    if match is None:
        return ["src/lib/relay.ts 里找不到 MCP_CALL_TIMEOUT_MS"]
    call_ms = _num(match.group(1))
    dotenv = find_dotenv()
    env_text = dotenv.read_text(encoding="utf-8") if dotenv else ""
    connect_s = resolve_seconds(env_text, CONNECT_TIMEOUT_ENV_KEY, 30.0)
    tool_s = resolve_seconds(env_text, TOOL_TIMEOUT_ENV_KEY, DEFAULT_TOOL_TIMEOUT)
    needed_ms = int((connect_s + tool_s) * 1000)
    if call_ms <= needed_ms:
        return [
            f"超时不等式破了:扩展 MCP_CALL_TIMEOUT_MS={call_ms}ms "
            f"必须 > 中继 CONNECT+TOOL={needed_ms}ms({connect_s:g}s + {tool_s:g}s)"
        ]
    return []


def last_probe_age() -> int:
    """扩展最后探活距今几秒;``-1`` 读不到日志,``-2`` 日志在但没痕迹."""
    now = datetime.now()
    readable = False
    best: datetime | None = None
    for path in PROBE_LOG_CANDIDATES:
        try:
            with open(path, errors="replace") as handle:
                readable = True
                for line in handle:
                    if not line.rstrip().endswith("] ping"):
                        continue
                    try:
                        when = datetime.strptime(line[1:20], "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        continue
                    if best is None or when > best:
                        best = when
        except OSError:
            continue
    if not readable:
        return -1
    if best is None:
        return -2
    return max(0, int((now - best).total_seconds()))


def _say(label: str, text: str) -> None:
    print(f"  {label:<6} {text}")


def cmd_check(_args: argparse.Namespace) -> int:
    """只读:对拍 + 探活现状.不改任何东西,可在 CI 里跑."""
    problems = check_timeouts()
    if problems:
        for line in problems:
            _say("超时", f"✗ {line}")
        return 1
    _say("超时", "✓ 不等式成立")
    age = last_probe_age()
    if age == -1:
        _say("探活", "读不到(中继可能不是本脚本起的、日志在别处)")
    elif age == -2:
        _say("探活", "日志在但没有痕迹(扩展没探活,或中继跑旧代码)")
    else:
        _say("探活", f"{age}s 前")
    return 0


def cmd_doctor(_args: argparse.Namespace) -> int:
    """环境快照:版本、产物、探活.人拿它一眼看出缺什么."""
    _say("python", sys.version.split()[0])
    _say("node", shutil.which("node") or "未安装")
    _say("pnpm", shutil.which("pnpm") or "未安装")
    mv3 = repo_root() / ".output" / "chrome-mv3" / "background.js"
    _say("产物", f"{'在' if mv3.is_file() else '缺'}:{mv3}")
    return cmd_check(_args)


def cmd_up(args: argparse.Namespace) -> int:
    """拉齐依赖 + 构建 + 对拍.幂等;前端工程文件不在就跳过那一半."""
    root = repo_root()
    pkg = root / "package.json"
    if pkg.is_file() and shutil.which("pnpm"):
        for cmd in (["pnpm", "install"], ["pnpm", "build"]):
            _say("执行", f"$ {' '.join(cmd)}")
            if subprocess.run(cmd, cwd=root).returncode != 0:
                _say("失败", f"{' '.join(cmd)}")
                return 1
    else:
        _say("跳过", "前端工程文件不在仓库里(package.json 缺或缺 pnpm)")
    if args.no_tests:
        _say("跳过", "对拍(用了 --no-tests)")
        return cmd_check(args)
    _say("执行", f"$ pytest -q {' '.join(ALIGNMENT_TESTS)}")
    rc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", *ALIGNMENT_TESTS],
        cwd=root,
    ).returncode
    if rc != 0:
        return rc
    return cmd_check(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dsb env", description="开发与测试环境")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, fn, help_text in (
        ("up", cmd_up, "拉齐依赖 + 构建 + 对拍(幂等)"),
        ("check", cmd_check, "只读:超时不等式 + 探活现状"),
        ("doctor", cmd_doctor, "环境快照:版本、产物、探活"),
    ):
        sub.add_parser(name, help=help_text).set_defaults(func=fn)
            # 只给 up 加开关;check / doctor 本来就不跑测试.
    for action in sub.choices.values():
        action.add_argument("--no-tests", action="store_true", help="跳过对拍")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
