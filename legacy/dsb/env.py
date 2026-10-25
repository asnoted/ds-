"""``dsb env``:浏览器管理.

只管独立 profile 的 Chromium:起 / 停 / 查.环境准备、构建、测试
那些事不在这儿(``uv run dsb`` 起网关,``pnpm build`` 构建扩展).

子命令:
    up      起浏览器(带扩展,带会话页;幂等)
    stop    停掉独立 profile 的浏览器
    status  查浏览器跑着没、扩展新不新
"""

from __future__ import annotations

import argparse

from dsb import browser as dsb_browser


def cmd_up(args: argparse.Namespace) -> int:
    return dsb_browser.browser_up(debug=args.debug, debug_port=args.debug_port)


def cmd_stop(_args: argparse.Namespace) -> int:
    return dsb_browser.browser_stop()


def cmd_status(_args: argparse.Namespace) -> int:
    return dsb_browser.browser_status()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dsb env", description="浏览器管理(独立 profile)"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    up = sub.add_parser("up", help="起浏览器(带扩展与会话页;幂等)")
    up.add_argument("--debug", action="store_true", help="带远程调试口")
    up.add_argument("--debug-port", type=int, default=9222, help="调试端口(默认 9222)")
    up.set_defaults(func=cmd_up)
    sub.add_parser("stop", help="停掉独立 profile 的浏览器").set_defaults(func=cmd_stop)
    sub.add_parser("status", help="查浏览器跑着没、扩展新不新").set_defaults(func=cmd_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
