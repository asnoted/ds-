"""业务日志:出过什么事,几点出的(房规:工具调用的入参与结果正文都不进日志).

`BaseHTTPRequestHandler.log_message` 在 server.py 里被整个关掉--那条路会把请求行原样
写下来,等于拿访问日志当业务日志.这里记的是另一件事:**失败,慢与探活**(探活一行,
无字段,喂 env-up 的'扩展最后探活'判据).事件名固定,字段有名有姓,事后
`grep -E 'tool-fail|tool-broke|bad-request|ping' /tmp/dsb.log` 就能回答'哪件工具
没成,几点没成的,慢在哪儿,扩展多久没探活了'.

字段是**具名参数**,不是自由 dict:调用点想写 ``arguments=...`` 都写不进去.正文进不来
靠的是签名,不是自觉;异常也只留类型名,不带 message(消息里可能嵌着用户的东西).
"""

from __future__ import annotations

import logging
import sys

LOGGER_NAME = "dsb"
LOG_FORMAT = "[%(asctime)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

#: 一次工具调用慢到这儿就留一笔.过了这条线多半是网关那头的子进程不健康,
#: 不记就成了无头案--这是"图标翻红"之前唯一能留下的先兆.
SLOW_MS = 1000


def _logger() -> logging.Logger:
    logger = logging.getLogger(LOGGER_NAME)
    if logger.level == logging.NOTSET:  # 没配过就默认记 INFO,别让根 logger 的 WARNING 把它咽了
        logger.setLevel(logging.INFO)
    return logger


def setup_logging() -> None:
    """把事件接到 stderr:`nohup uv run dsb > /tmp/dsb.log 2>&1` 正好收下.

    只在起服务时调一次.测试不调,所以 pytest 里既不会重复打印,caplog 又照常捞得到
    (记录照样向上冒泡).
    """
    logger = _logger()
    if logger.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(LOG_FORMAT, DATE_FORMAT))
    logger.addHandler(handler)


def log_event(
    event: str,
    *,
    took_ms: float | None = None,
    http: int | None = None,
    path: str | None = None,
    error: str | None = None,
    exc: BaseException | None = None,
    missing: str | None = None,
    tool: str | None = None,
    chars: int | None = None,
    count: int | None = None,
) -> None:
    """一条事件,形如 ``[2026-10-03 14:49:36] tool-fail tool=fs_echo error=tool-timeout``.

    只收这几个具名字段:工具调用的入参,结果正文,异常消息都进不来.事件名固定,字段
    有名有姓,事后 ``grep -E 'tool-fail|tool-broke|bad-request' /tmp/dsb.log`` 就能回答
    '哪件工具没成,几点没成的,慢在哪儿'.
    """
    bits = [event]
    if path is not None:
        bits.append(f"path={path}")
    if tool is not None:
        bits.append(f"tool={tool}")
    if http is not None:
        bits.append(f"http={http}")
    if error is not None:
        bits.append(f"error={error}")
    if exc is not None:
        bits.append(f"exc={type(exc).__name__}")
    if took_ms is not None:
        bits.append(f"took_ms={round(took_ms)}")
    if missing is not None:
        bits.append(f"missing={missing}")
    if chars is not None:
        bits.append(f"chars={chars}")
    if count is not None:
        bits.append(f"count={count}")
    _logger().info(" ".join(bits))
