"""网页说给人听的话:**没排围栏**的那些 assistant 消息.

扩展在读完一条出站响应,认定里面没有 ``say`` 围栏时,把这段正文报上来(工具
``said_add``);协调者(与用户会话的 agent)来取(工具 ``said_read``).这样网页想说给人
的话不再无声无息地挂在页面上等人凑巧看到.

原来那条 ``/said`` HTTP 路与 CORS 分头认一起废了(ADR-0011):都走 ``/mcp``--网页的
跨域预检拿不到允许头照旧撞死,扩展与本机进程照旧放行.只留最近 :data:`SAID_LIMIT` 条.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Mapping
from typing import Any

SAID_LIMIT = 50
Payload = dict[str, Any]


class SaidLog:
    """最近几条'说给人的话',有界;线程安全交给 GIL 与 deque 的原子 append.

    两个方法就是两件工具的处理器形状(``参数 → (载荷, 这算不算失败)``,见
    :class:`dsb.mcp.Tool`),直接注册,不再隔一层 HTTP 解析.
    """

    def __init__(self, limit: int = SAID_LIMIT) -> None:
        self._items: deque[dict[str, Any]] = deque(maxlen=limit)

    def tool_add(self, arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        """``said_add``:正文不合 ``{"text": "..."}`` 归到册子里的 unexpected-response."""
        text = arguments.get("text")
        if not isinstance(text, str) or not text.strip():
            return {"status": "error", "error": "unexpected-response"}, True
        self._items.append({"text": text, "at": time.time()})
        return {"status": "ok"}, False

    def tool_read(self, _arguments: Mapping[str, Any]) -> tuple[Payload, bool]:
        """``said_read``:整份交出去(读侧没有失败可言)."""
        return {"status": "ok", "said": list(self._items)}, False


__all__ = ["SAID_LIMIT", "SaidLog"]
