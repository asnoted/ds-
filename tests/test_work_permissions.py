"""工作工具的权限规则(#89):读写两侧对 ``mcp.json`` / ``.env`` 系一律拒绝.

判定逻辑本身在 :mod:`dsb.permissions`(那里测通配语义),这里是**接线**的对拍:每个
失败点都走真实文件,真实 ``resolve()``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from dsb.work import (
    ERROR_OUT_OF_ROOT,
    ERROR_PROTECTED,
    WorkError,
    edit_text,
    glob_tree,
    grep_tree,
    is_protected,
    read_text,
    write_text,
)

#: 读出来就会**随回灌进对话**(也就是发给站点)的标记串.
SECRET = "SECRET-API-KEY-abc123"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """一个工作 root:真有一份 ``mcp.json``(含标记串)与几档 ``.env``."""
    (tmp_path / "mcp.json").write_text(
        '{"dsb-gateway": {"command": "npx", "env": {"TOKEN": "' + SECRET + '"}}}',
        encoding="utf-8",
    )
    (tmp_path / ".env").write_text(f"DSB_WORK_ROOT=/tmp/x\nTOKEN={SECRET}\n", encoding="utf-8")
    (tmp_path / ".env.local").write_text(f"TOKEN={SECRET}\n", encoding="utf-8")
    (tmp_path / ".env.example").write_text("TOKEN=填上你的\n", encoding="utf-8")
    (tmp_path / "mcp.json.bak").write_text("老配置\n", encoding="utf-8")
    sub = tmp_path / "sub" / "dir"
    sub.mkdir(parents=True)
    (sub / ".env").write_text(f"TOKEN={SECRET}\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("普通文件,看得见.\n", encoding="utf-8")
    return tmp_path


def code_of(action: object) -> str:
    """跑一个动作,回它的失败码(不失败就回空串)."""
    try:
        action()  # type: ignore[operator]
    except WorkError as error:
        return error.code
    return ""


class Test读侧:
    @pytest.mark.parametrize(
        "path",
        ["mcp.json", ".env", ".env.local", "sub/dir/.env"],
    )
    def test_拒读_mcp_json_与_env_系(self, root: Path, path: str) -> None:
        assert code_of(lambda: read_text(root, path)) == ERROR_PROTECTED

    def test_拒读时一个字的标记都不回(self, root: Path) -> None:
        with pytest.raises(WorkError) as caught:
            read_text(root, "mcp.json")
        assert SECRET not in str(caught.value.detail or "")

    @pytest.mark.parametrize("path", [".env.example", "mcp.json.bak", "README.md"])
    def test_样例与备份不误拒(self, root: Path, path: str) -> None:
        assert read_text(root, path)  # 不抛就是读到了


class Test写侧:
    @pytest.mark.parametrize("path", ["mcp.json", ".env", ".env.local", "sub/dir/.env"])
    def test_拒写_mcp_json_与_env_系(self, root: Path, path: str) -> None:
        assert code_of(lambda: write_text(root, path, "x")) == ERROR_PROTECTED
        edit = lambda: edit_text(root, path, [{"old": "TOKEN", "new": "y"}])  # noqa: E731
        assert code_of(edit) == ERROR_PROTECTED

    def test_拒写时文件原样未动(self, root: Path) -> None:
        before = (root / "mcp.json").read_text(encoding="utf-8")
        with pytest.raises(WorkError):
            write_text(root, "mcp.json", "改了")
        assert (root / "mcp.json").read_text(encoding="utf-8") == before

    def test_普通文件照常读写(self, root: Path) -> None:
        assert write_text(root, "notes.md", "hello") == 5
        assert read_text(root, "notes.md") == "1: hello\n(文件读完:共 1 行)"


class Test大小写与绕过:
    """macOS 大小写不敏感:``MCP.JSON`` 打开的是真文件,规则也得拦."""

    @pytest.mark.parametrize("path", ["MCP.JSON", "Mcp.Json", ".ENV", ".Env"])
    def test_大写写法照样拒(self, root: Path, path: str) -> None:
        assert code_of(lambda: read_text(root, path)) == ERROR_PROTECTED
        assert code_of(lambda: write_text(root, path, "x")) == ERROR_PROTECTED

    def test_相对写法与中间目录归一(self, root: Path) -> None:
        assert code_of(lambda: read_text(root, "./mcp.json")) == ERROR_PROTECTED
        assert code_of(lambda: read_text(root, "sub/../mcp.json")) == ERROR_PROTECTED

    def test_指向保护文件的符号链接也拒(self, root: Path) -> None:
        link = root / "link.json"
        link.symlink_to(root / "mcp.json")
        assert code_of(lambda: read_text(root, "link.json")) == ERROR_PROTECTED

    def test_名字以_root_开头的兄弟目录不算在_root_内(self, root: Path) -> None:
        """``<root>-evil`` 的字符串前缀就是 root--"前缀法"那种判法会把它当成 root 里.

        这不是假想:沙箱边界就一句判断,改成前缀比对一样能跑通既有的越界用例
        (``/etc/passwd`` 那种),只有**兄弟目录**才把它照出来.
        """
        sibling = root.parent / f"{root.name}-evil"
        sibling.mkdir()
        (sibling / "secret.txt").write_text(SECRET, encoding="utf-8")
        assert code_of(lambda: read_text(root, str(sibling / "secret.txt"))) == ERROR_OUT_OF_ROOT


class Test根写法:
    """root 递进来是**别的写法**时,护栏不许静默放行."""

    def test_root_是符号链接写法时保护文件照样拒(self, root: Path) -> None:
        """``/var`` 与 ``/private/var`` 是同一个目录的两种写法(macOS).

        判定要拿 ``resolve()`` 之后的两侧比:少了这一步,``relative_to`` 抛错就被折成
        "不在 root 内",而 :func:`dsb.work.is_protected` 把 ``None`` 当**不保护**--
        于是 ``.env``(它能改 ``DSB_WORK_ROOT``,把沙箱自己撑开)反倒读写都放行.
        """
        alias = root.parent / f"{root.name}-link"
        alias.symlink_to(root, target_is_directory=True)
        assert code_of(lambda: read_text(alias, "mcp.json")) == ERROR_PROTECTED
        assert code_of(lambda: write_text(alias, ".env", "DSB_WORK_ROOT=/\n")) == ERROR_PROTECTED


class Test绝对路径:
    def test_绝对路径指到保护文件照样拒(self, root: Path) -> None:
        assert code_of(lambda: read_text(root, str(root / "mcp.json"))) == ERROR_PROTECTED


class Test真实生效的那一个:
    """名字或位置与默认不同,只要落在 root 内,同样读写都拒(#89 第二层)."""

    def test_配到_root_内别处的_mcp_config_也拒(
        self, root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        elsewhere = root / "config" / "my-servers.json"
        elsewhere.parent.mkdir()
        elsewhere.write_text('{"dsb-gateway": {"command": "sh"}}', encoding="utf-8")
        monkeypatch.setenv("DSB_MCP_CONFIG", str(elsewhere))
        assert code_of(lambda: read_text(root, "config/my-servers.json")) == ERROR_PROTECTED
        assert code_of(lambda: write_text(root, "config/my-servers.json", "x")) == ERROR_PROTECTED

    def test_同一份文件换个名字的硬链接也拒(
        self, root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """macOS 大小写不敏感与硬链接都是同一 inode 的两种写法;按路径字符串比会漏."""
        elsewhere = root / "config" / "my-servers.json"
        elsewhere.parent.mkdir()
        elsewhere.write_text('{"dsb-gateway": {"command": "sh"}}', encoding="utf-8")
        monkeypatch.setenv("DSB_MCP_CONFIG", str(elsewhere))
        alias = root / "config" / "alias.json"
        os.link(elsewhere, alias)
        assert code_of(lambda: read_text(root, "config/alias.json")) == ERROR_PROTECTED
        assert code_of(lambda: write_text(root, "config/alias.json", "x")) == ERROR_PROTECTED

    def test_没配时_root_里那个_mcp_json_仍拒(
        self, root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DSB_MCP_CONFIG", raising=False)
        assert code_of(lambda: read_text(root, "mcp.json")) == ERROR_PROTECTED

    def test_还没落盘的生效配置换个大小写也拒(
        self, root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """文件不在盘上时没有 inode 可比;换个大小写在 macOS 上写的还是同一份."""
        elsewhere = root / "config" / "my-servers.json"
        elsewhere.parent.mkdir()
        monkeypatch.setenv("DSB_MCP_CONFIG", str(elsewhere))
        assert code_of(lambda: write_text(root, "config/My-Servers.json", "{}")) == ERROR_PROTECTED

    def test_还没落盘的生效配置换个_Unicode_规范化写法也拒(
        self, root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """APFS 按 Unicode 规范化认名:NFC 与 NFD 写的是同一份,没 inode 时只折大小写会漏."""
        composed = root / "config" / "caf\u00e9.json"
        decomposed = root / "config" / "cafe\u0301.json"
        composed.parent.mkdir()
        monkeypatch.setenv("DSB_MCP_CONFIG", str(composed))
        assert code_of(lambda: write_text(root, str(decomposed), "{}")) == ERROR_PROTECTED

    def test_生效的_env_不是_UTF8_时工具照常可用(
        self, root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """读不出的 .env 只该当没配:不能让每次工具调用都落成内部错."""
        monkeypatch.chdir(root)
        (root / ".env").write_bytes(b"TOKEN=\xff\n")
        assert "普通文件" in read_text(root, "README.md")


class TestGrep:
    def test_模式命中保护文件时结果里没有它(self, root: Path) -> None:
        out = grep_tree(root, SECRET)
        assert SECRET not in out
        assert "mcp.json" not in out
        assert ".env" not in out

    def test_别的文件照常命中(self, root: Path) -> None:
        (root / "app.py").write_text(f"token = '{SECRET}'\n", encoding="utf-8")
        out = grep_tree(root, SECRET)
        assert "app.py" in out
        assert SECRET in out

    def test_子目录里的_env_也搜不到(self, root: Path) -> None:
        out = grep_tree(root, SECRET)
        assert "sub" not in out

    def test_指定路径直指保护文件时也不给内容(self, root: Path) -> None:
        out = grep_tree(root, SECRET, "mcp.json")
        assert SECRET not in out


class TestGlob:
    def test_仍如实列出名字(self, root: Path) -> None:
        out = glob_tree(root, "*")
        assert "mcp.json" in out
        assert ".env" in out


def test_protection_check_fails_closed_when_it_cannot_resolve(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """解析不了生效配置时按受保护收场,不能把 mcp.json / .env 放出去."""

    def boom(_root: Path) -> tuple[Path, ...]:
        raise OSError("配置路径坏了")

    monkeypatch.setattr("dsb.work._effective_sensitive", boom)
    assert is_protected(root, root / "README.md", "read") is True
