"""权限规则层的判定(#89):通配语义,last-match-wins,大小写不敏感."""

from __future__ import annotations

import pytest

from dsb.permissions import (
    DEFAULT_RULES,
    Rule,
    decide,
    is_allowed,
    match_rule,
    rules_for,
)

READ = rules_for("read")
EDIT = rules_for("edit")


class Test通配语义:
    def test_星号能跨斜杠(self) -> None:
        assert decide(EDIT, "a/b/c/d.py") == "allow"
        assert match_rule((Rule("a/*", "deny"),), "a/b/c/d.py") is not None

    def test_问号恰好一个字符(self) -> None:
        rules = (Rule("?.env", "deny"),)
        assert match_rule(rules, "a.env") is not None
        assert match_rule(rules, "ab.env") is None
        assert match_rule(rules, ".env") is None

    def test_星号能匹配零个字符(self) -> None:
        assert match_rule((Rule("a*z", "deny"),), "az") is not None
        assert match_rule((Rule("a*z", "deny"),), "abcz") is not None

    def test_其余字符按字面(self) -> None:
        # 正则元字符不该有"表达式"待遇:模式是数据.
        assert match_rule((Rule("a.c", "deny"),), "a.c") is not None
        assert match_rule((Rule("a.c", "deny"),), "abc") is None
        assert match_rule((Rule("a+b", "deny"),), "a+b") is not None
        assert match_rule((Rule("a+b", "deny"),), "aab") is None

    def test_反斜杠归一成斜杠(self) -> None:
        assert match_rule((Rule("a/b", "deny"),), "a\\b") is not None


class Test最后命中的赢:
    def test_先写兜底再写具体的(self) -> None:
        rules = (Rule("*", "allow"), Rule("secret/*", "deny"))
        assert decide(rules, "secret/x") == "deny"
        assert decide(rules, "public/x") == "allow"

    def test_顺序反过来就反过来(self) -> None:
        rules = (Rule("secret/*", "deny"), Rule("*", "allow"))
        assert decide(rules, "secret/x") == "allow"

    def test_多条命中取最后一条(self) -> None:
        rules = (Rule("*.env", "deny"), Rule("*.env.*", "deny"), Rule("*.env.example", "allow"))
        assert decide(rules, ".env") == "deny"
        assert decide(rules, ".env.local") == "deny"
        assert decide(rules, ".env.example") == "allow"

    def test_一条没中默认放行(self) -> None:
        assert decide((Rule("x", "deny"),), "y") == "allow"
        assert match_rule((Rule("x", "deny"),), "y") is None


class Test大小写不敏感:
    """macOS 文件系统默认大小写不敏感而 ``resolve()`` 不规范化大小写--不敏感匹配是刚需."""

    @pytest.mark.parametrize(
        "path",
        ["MCP.JSON", "Mcp.Json", "mcp.json"],
    )
    def test_mcp_json_各种大小写都拒(self, path: str) -> None:
        assert is_allowed("read", path) is False
        assert is_allowed("edit", path) is False

    @pytest.mark.parametrize("path", [".ENV", ".Env", ".env", "sub/.ENV"])
    def test_env_各种大小写都拒(self, path: str) -> None:
        assert is_allowed("read", path) is False
        assert is_allowed("edit", path) is False

    def test_git_各种大小写都拒(self) -> None:
        assert is_allowed("edit", ".GIT") is False
        assert is_allowed("edit", ".Git/config") is False


class Test默认规则表:
    def test_读侧拒_env_系与_mcp_json_放行样例(self) -> None:
        for denied in [".env", ".env.local", "sub/dir/.env", "mcp.json", ".env.production"]:
            assert is_allowed("read", denied) is False, denied
        for allowed in [".env.example", "mcp.json.bak", "docs/mcp.json.md", "README.md"]:
            assert is_allowed("read", allowed) is True, allowed

    def test_写侧比读侧多拒_git(self) -> None:
        assert is_allowed("read", ".git/config") is True  # 读侧不拦 .git
        assert is_allowed("edit", ".git") is False
        assert is_allowed("edit", ".git/config") is False
        assert is_allowed("edit", ".git/hooks/pre-commit") is False

    def test_子目录里的_env_也拒(self) -> None:
        # `*` 跨 `/`,所以任意深度的 .env 系都拒.
        assert is_allowed("edit", "a/b/.env") is False
        assert is_allowed("edit", "deep/nested/dir/.env.local") is False

    def test_嵌套的_mcp_json_不拒(self) -> None:
        """子目录里那个 ``mcp.json`` 是**死的**--dsb 只读被配置指到的那一个.

        '真实生效的那一个'由 :func:`dsb.work.is_protected` 第二层按实际路径拦
        (无论它被 ``DSB_MCP_CONFIG`` 指到哪儿),规则表里不必按名字铺开--铺开就是
        ADR-0012 反对的那种'越做越像沙箱'的名单位置.
        """
        assert is_allowed("edit", "deep/nested/dir/mcp.json") is True

    def test_普通的源文件照常放行(self) -> None:
        for path in ["dsb/work.py", "src/lib/action.ts", "a/b/c/test.py", "docs/adr/0001-x.md"]:
            assert is_allowed("edit", path) is True, path
            assert is_allowed("read", path) is True, path

    def test_两份表独立(self) -> None:
        assert DEFAULT_RULES["read"] is not DEFAULT_RULES["edit"]
        # .git 只在 edit 那份里
        assert is_allowed("read", ".git") is True
        assert is_allowed("edit", ".git") is False
