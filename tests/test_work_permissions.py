"""五件工作工具的权限规则(#89):读写两侧对 ``mcp.json`` / ``.env`` 系一律拒绝.

判定逻辑本身在 :mod:`dsb.permissions`(那里测通配语义),这里是**接线**的对拍:每个
失败点都走真实文件,真实 ``resolve()``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dsb.work import (
    ERROR_PROTECTED,
    WorkError,
    edit_text,
    grep_tree,
    list_dir,
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
        assert code_of(lambda: edit_text(root, path, "TOKEN", "y")) == ERROR_PROTECTED

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

    def test_没配时_root_里那个_mcp_json_仍拒(
        self, root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DSB_MCP_CONFIG", raising=False)
        assert code_of(lambda: read_text(root, "mcp.json")) == ERROR_PROTECTED


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


class TestLs:
    def test_仍如实列出名字(self, root: Path) -> None:
        out = list_dir(root)
        assert "mcp.json" in out
        assert ".env" in out
        assert "mcp.json" in out
        assert ".env" in out
