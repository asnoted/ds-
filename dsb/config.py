"""``.env`` 解析纯函数(现读不落盘,不发任何请求).

只剩两个键要认:

- ``DSB_PORT``:监听端口(默认 8787);
- ``DSB_TOOL_TIMEOUT``:一次工具调用等子进程的时限(秒,见 :mod:`dsb.gateway`).

``DSB_WORK_ROOT``(工作文件夹 root)用同款口径在 :mod:`dsb.work` 里解析,不走本模块.

``OPENSESS_ID`` / ``DSB_IDLE_TIMEOUT`` / ``DSB_ACTIONS_ENABLED`` 都随问答后端与动作服务
一起废了(ADR-0011)--没有会话要起,没有问句要等,没有动作要放行.
"""

from __future__ import annotations

import os
from pathlib import Path

PORT_ENV_KEY = "DSB_PORT"


def env_value(env_text: str, key: str) -> str | None:
    """``.env`` 文本 → 某个键的值;注释与别的变量一律忽略,缺键返回 None.

    进程环境变量优先还是 .env 优先由调用方定(各自 ``os.environ.get(key) or ...``),
    这里只管 .env 那半边.
    """
    for line in env_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        name, separator, value = stripped.partition("=")
        if not separator or name.strip() != key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        return value or None
    return None


def repo_root() -> Path:
    """包所在的仓库根:``.env`` 与 ``mcp.json`` 都落在这儿."""
    return Path(__file__).resolve().parents[1]


def find_dotenv() -> Path | None:
    """``.env`` 的落点:先看当前目录,再看包所在仓库根."""
    for candidate in (Path.cwd() / ".env", repo_root() / ".env"):
        if candidate.is_file():
            return candidate
    return None


#: ``mcp.json`` 的文件名与它的配置键(``DSB_MCP_CONFIG`` 指向别处时用后者).
MCP_CONFIG_FILENAME = "mcp.json"
MCP_CONFIG_ENV_KEY = "DSB_MCP_CONFIG"


def resolve_config_path(env_text: str) -> Path:
    """``mcp.json`` 的落点:环境变量/``.env`` 的 ``DSB_MCP_CONFIG`` 优先,其次当前目录,最后仓库根.

    住在这里而不是 :mod:`dsb.server`,是因为**它有两个读者**:中继读它去拉起 servers,
    工作工具的护栏也要知道'真正生效的那一个配置'是哪个(#89)--各抄一份必然漂.
    """
    raw = os.environ.get(MCP_CONFIG_ENV_KEY) or env_value(env_text, MCP_CONFIG_ENV_KEY)
    if raw:
        return Path(raw).expanduser()
    for candidate in (Path.cwd() / MCP_CONFIG_FILENAME, repo_root() / MCP_CONFIG_FILENAME):
        if candidate.is_file():
            return candidate
    return repo_root() / MCP_CONFIG_FILENAME  # 默认落点(文件不在就是空表)


__all__ = [
    "MCP_CONFIG_ENV_KEY",
    "MCP_CONFIG_FILENAME",
    "PORT_ENV_KEY",
    "env_value",
    "find_dotenv",
    "repo_root",
    "resolve_config_path",
]
