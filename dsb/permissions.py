"""工作工具的权限规则层(#89):按操作分类,**最后一条命中的规则赢**.

照 opencode 的权限口径做(``opencode.ai/docs/permissions``):规则是**数据**,不是代码里
的一张名单--每条 ``pattern -> allow | deny``,通配符 ``*``(零个或多个任意字符,**含
``/``**)与 ``?``(恰好一个字符),先写兜底 ``*`` 再写更具体的,命中多条时**最后一条赢**.

只认 ``allow`` / ``deny`` 两种结论:dsb 是被动的无状态网关(ADR-0011),没有交互面,
逐次确认(opencode 的 ``ask``)无处安放.

匹配对象是**根相对,POSIX 分隔,``resolve()`` 之后**的路径,所以符号链接与 ``..`` 绕不过
去;**匹配大小写不敏感**--macOS 文件系统默认大小写不敏感而 ``resolve()`` 不规范化大小
写,``MCP.JSON`` 能打开真文件却会躲过字符串匹配(真机 2026-10-08 补的坑).

本模块只管'这个操作对这条路径允不允许',不碰文件系统:判定是纯函数,单测直接喂字符串.
调用点(:mod:`dsb.work`)负责在 ``resolve()`` 之后把根相对路径递进来.
"""

from __future__ import annotations

import re
from typing import Literal, NamedTuple

Verdict = Literal["allow", "deny"]

#: 两类操作:``read``(读内容:``read`` 与 ``grep`` 的内容读取),``edit``(``write`` / ``edit``).
Operation = Literal["read", "edit"]

#: 根相对路径的默认放行:兜底写在最前,后面的具体规则覆盖它.
ALLOW_ALL = "*"


class Rule(NamedTuple):
    """一条规则:``pattern`` 命中这条根相对路径时给 ``verdict``."""

    pattern: str
    verdict: Verdict


def _to_regex(pattern: str) -> re.Pattern[str]:
    """把 ``*`` / ``?`` 通配编译成正则.**只认这两种**,其余字符一律字面.

    ``*`` 跨 ``/``(opencode 的口径:``"*"`` 是兜底,得能盖住整条路径);
    ``?`` 恰好一个字符.路径里的正则元字符全部按字面转义--模式是数据,不是表达式.
    """
    out: list[str] = ["(?s)\\A"]
    for char in pattern:
        if char == "*":
            out.append(".*")
        elif char == "?":
            out.append(".")
        else:
            out.append(re.escape(char))
    out.append("\\Z")
    return re.compile("".join(out), re.IGNORECASE)


def match_rule(rules: tuple[Rule, ...], relative: str) -> Rule | None:
    """**最后一条命中的规则**(照 opencode 的 last-match-wins);一条没中回 ``None``."""
    normalized = relative.replace("\\", "/")
    winner: Rule | None = None
    for rule in rules:
        if _to_regex(rule.pattern).match(normalized):
            winner = rule
    return winner


def decide(rules: tuple[Rule, ...], relative: str) -> Verdict:
    """这条路径这个操作允不允许.一条规则都没命中时**默认放行**(表里的兜底负责收口)."""
    winner = match_rule(rules, relative)
    if winner is None:
        return "allow"
    return winner.verdict


#: 默认规则表(#89).``read`` 与 ``edit`` 各一份,同名规则在两份里都写出来而不是共用的
#: -- 两份表独立演进,某天只该拒写时不必去读另一份.
#:
#: 拒的只有两类,都是"不经人看就会生效"的本机配置:
#:
#: - ``mcp.json``:dsb 启动时用 ``subprocess.Popen`` 直接拉起其中的 ``command`` +
#:   ``args``(写入它 = 下次中继重启后任意命令执行),它的 ``env`` 里还可能放着第三方
#:   MCP 服务的 API key(读出来会**随回灌进对话,也就是发给站点**).这个模式**不跨
#:   目录**:子目录里那个同名文件是死的,dsb 压根不读它;真正生效的那一个(可能被
#:   ``DSB_MCP_CONFIG`` 指到 root 内别处)由 :func:`dsb.work.is_protected` 第二层按
#:   **实际路径**拦.名字铺开就是 ADR-0012 反对的那种"越做越像沙箱"的名单位置.
#: - ``*.env`` / ``*.env.*``:``.env`` 能改 ``DSB_WORK_ROOT``,把沙箱自己撑开.这里
#:   **跨目录**(``*`` 含 ``/``)--各处的 ``.env`` 都是同一种东西,且样例文件
#:   (``.env.example``)显式放行.
#:
#: ``.git/`` 从"写死的特例"收进这张表:``.git/hooks`` 与 ``mcp.json`` 是同一类文件
#: (不经人看就会执行),护栏的理由本来就一样(ADR-0024).
DEFAULT_RULES: dict[Operation, tuple[Rule, ...]] = {
    "read": (
        Rule(ALLOW_ALL, "allow"),
        Rule("*.env", "deny"),
        Rule("*.env.*", "deny"),
        # 放行样例:它是给人看的模板,里面没有真密钥.
        Rule("*.env.example", "allow"),
        Rule("mcp.json", "deny"),
    ),
    "edit": (
        Rule(ALLOW_ALL, "allow"),
        Rule(".git", "deny"),
        Rule(".git/*", "deny"),
        Rule("*.env", "deny"),
        Rule("*.env.*", "deny"),
        Rule("*.env.example", "allow"),
        Rule("mcp.json", "deny"),
    ),
}


def rules_for(operation: Operation) -> tuple[Rule, ...]:
    """某个操作用的规则表(本票不做用户可配:没有配置面,YAGNI)."""
    return DEFAULT_RULES[operation]


def is_allowed(operation: Operation, relative: str) -> bool:
    """便捷判定:``True`` = 允许."""
    return decide(rules_for(operation), relative) == "allow"


__all__ = [
    "ALLOW_ALL",
    "DEFAULT_RULES",
    "Operation",
    "Rule",
    "Verdict",
    "decide",
    "is_allowed",
    "match_rule",
    "rules_for",
]
