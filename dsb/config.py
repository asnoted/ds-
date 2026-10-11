"""``.env`` 解析纯函数(现读不落盘,不发任何请求).

只剩两个键要认:

- ``DSB_PORT``:监听端口(默认 8787);
- ``DSB_TOOL_TIMEOUT``:一次工具调用等子进程的时限(秒,见 :mod:`dsb.gateway`).

``DSB_WORK_ROOT``(工作文件夹 root)用同款口径在 :mod:`dsb.work` 里解析,不走本模块.

``OPENSESS_ID`` / ``DSB_IDLE_TIMEOUT`` / ``DSB_ACTIONS_ENABLED`` 都随问答后端与动作服务
一起废了(ADR-0011)--没有会话要起,没有问句要等,没有动作要放行.
"""

from __future__ import annotations

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


__all__ = ["PORT_ENV_KEY", "env_value", "find_dotenv", "repo_root"]
