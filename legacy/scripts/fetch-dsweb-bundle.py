"""抓 DeepSeek 网页的前端 bundle 到 dsweb/bundle/,供离线逆向用.

**为什么要有它**:逆向网页要反复 grep 同一批 JS,而 CDN 每次都可能换
hash(文件名里带 `main.<hash>.js`).所以脚本从线上页面**自动发现**当前的
bundle 列表,而不是把 URL 写死--写死就会在某次发版后悄悄拿到旧包.

**用法**(直连不通时默认走本机代理 7897):

    uv run scripts/fetch-dsweb-bundle.py
    uv run scripts/fetch-dsweb-bundle.py --proxy ""        # 不走代理
    uv run scripts/fetch-dsweb-bundle.py --out /tmp/x      # 换落盘目录
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PAGE = "https://chat.deepseek.com/"
DEFAULT_PROXY = "http://127.0.0.1:7897"
DEFAULT_OUT = Path("dsweb/bundle")
SCRIPT_SRC = re.compile(r'<script[^>]+src="([^"]+)"', re.IGNORECASE)
# bundle 落在 CDN 上(页面本身可能还有别的 script,如内联配置),只取静态资源
CDN_HOST = "fe-static.deepseek.com"
RETRY_STATUS = {429, 500, 502, 503, 504}  # 限流与临时故障,都值得重试
TAG = "[fetch-dsweb-bundle]"


def _opener(proxy: str) -> urllib.request.OpenerDirector:
    """按需挂代理;`--proxy ""` 走直连."""
    handlers: list[urllib.request.BaseHandler] = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


def _fetch(url: str, proxy: str, timeout: float, attempts: int = 4) -> bytes:
    """抓一个 URL,限流/临时故障就退避重试.

    CDN 与本机代理都会回 429;不重试的话脚本就是'看运气'--一会儿成,
    一会儿 429,逆向材料能不能拿到全凭当时网络心情.
    """
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with _opener(proxy).open(url, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            last = err
            if err.code not in RETRY_STATUS:
                raise SystemExit(f"{TAG} {url} → HTTP {err.code}(不该重试):{err.reason}") from err
            if attempt == attempts:
                break
            wait = 2**attempt  # 2s, 4s, 8s
            print(f"{TAG} {url} → HTTP {err.code},{wait}s 后重试({attempt}/{attempts - 1})")
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError) as err:
            last = err
            if attempt == attempts:
                break
            wait = 2**attempt
            print(f"{TAG} {url} → {err},{wait}s 后重试({attempt}/{attempts - 1})")
            time.sleep(wait)
    # 走到这儿是"该重试的都试完了还是不行".只说观察到的,不断言是谁在限流:
    # 2026-10-10 实测**经代理与直连都是 429**,所以不是代理出口 IP 的问题,
    # 换线路这条已经试过,没用,不该再当建议抛出来.等限流解除才是唯一的路.
    got = getattr(last, "code", None)
    hint = "被限流(HTTP 429):经代理与直连都试过,都被拒;等限流解除再跑" if got == 429 else "网络不通"
    raise SystemExit(f"{TAG} {url} 取不到(试了 {attempts} 次,最后一次:{last}).{hint}.")


def discover(page_url: str, proxy: str) -> list[str]:
    """取页面里的 bundle URL;发现不到就报错,别静默抓空."""
    html = _fetch(page_url, proxy, timeout=60).decode("utf-8", "replace")
    urls = [u for u in SCRIPT_SRC.findall(html) if CDN_HOST in u]
    if not urls:
        raise SystemExit(f"{TAG} {page_url} 里没找到 {CDN_HOST} 的 script src--页面结构可能变了")
    return urls


def download(url: str, out: Path, proxy: str) -> Path:
    """下载一个 bundle,返回落盘路径(文件名取 URL 末段)."""
    dest = out / url.rsplit("/", 1)[-1]
    dest.parent.mkdir(parents=True, exist_ok=True)
    data = _fetch(url, proxy, timeout=120)
    dest.write_bytes(data)
    print(f"{TAG} {dest}  {len(data):,} 字节")
    return dest


def main() -> None:
    parser = argparse.ArgumentParser(description="抓 DeepSeek 网页前端 bundle 到本地供逆向")
    parser.add_argument("--page", default=DEFAULT_PAGE, help=f"页面地址(默认 {DEFAULT_PAGE})")
    parser.add_argument(
        "--proxy", default=DEFAULT_PROXY, help=f"代理(默认 {DEFAULT_PROXY};空串=直连)"
    )
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT, help=f"落盘目录(默认 {DEFAULT_OUT})"
    )
    args = parser.parse_args()

    urls = discover(args.page, args.proxy)
    print(f"{TAG} 发现 {len(urls)} 个 bundle")
    for url in urls:
        download(url, args.out, args.proxy)


if __name__ == "__main__":
    sys.exit(main())
