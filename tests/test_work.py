"""工作工具:路径沙箱,五件行为,截断与上限,``.git`` 护栏,各错码(ADR-0012)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from dsb.work import (
    ERROR_BAD_PATH,
    ERROR_BAD_REGEX,
    ERROR_EDIT_NO_MATCH,
    ERROR_EDIT_NOT_UNIQUE,
    ERROR_IO_FAILED,
    ERROR_NOT_A_DIRECTORY,
    ERROR_NOT_A_FILE,
    ERROR_NOT_FOUND,
    ERROR_OUT_OF_ROOT,
    ERROR_PROTECTED,
    WORK_ROOT_ENV_KEY,
    WorkError,
    edit_text,
    grep_tree,
    list_dir,
    protected_git,
    read_text,
    resolve_in_root,
    resolve_work_root,
    work_tools,
    write_text,
)


def code_of(exc: pytest.ExceptionInfo[WorkError]) -> str:
    return exc.value.code


# ---- resolve_in_root ----


def test_relative_paths_resolve_under_the_root(tmp_path: Path) -> None:
    assert resolve_in_root(tmp_path, "a/b.txt") == (tmp_path / "a" / "b.txt").resolve()


def test_absolute_paths_inside_the_root_are_accepted(tmp_path: Path) -> None:
    inside = tmp_path / "x.txt"
    assert resolve_in_root(tmp_path, str(inside)) == inside.resolve()


def test_dot_resolves_to_the_root_itself(tmp_path: Path) -> None:
    assert resolve_in_root(tmp_path, ".") == tmp_path.resolve()


def test_parent_escape_is_refused(tmp_path: Path) -> None:
    with pytest.raises(WorkError) as exc:
        resolve_in_root(tmp_path / "root", "../secret.txt")
    assert code_of(exc) == ERROR_OUT_OF_ROOT


def test_symlink_escape_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("别碰", encoding="utf-8")
    (root / "link").symlink_to(outside)
    with pytest.raises(WorkError) as exc:
        resolve_in_root(root, "link/secret.txt")
    assert code_of(exc) == ERROR_OUT_OF_ROOT


def test_symlink_that_stays_inside_is_allowed(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / "real").mkdir()
    (root / "link").symlink_to(root / "real")
    assert resolve_in_root(root, "link") == (root / "real").resolve()


def test_an_empty_path_is_bad_path(tmp_path: Path) -> None:
    for raw in ("", "   ", None, 42):
        with pytest.raises(WorkError) as exc:
            resolve_in_root(tmp_path, raw)
        assert code_of(exc) == ERROR_BAD_PATH


# ---- list_dir ----


def test_list_dir_sorts_and_marks_directories(tmp_path: Path) -> None:
    (tmp_path / "sub").mkdir()
    (tmp_path / "b.txt").write_text("b", encoding="utf-8")
    (tmp_path / "a.txt").write_text("a", encoding="utf-8")
    assert list_dir(tmp_path, ".") == "a.txt\nb.txt\nsub/"


def test_list_dir_of_an_empty_directory_says_so(tmp_path: Path) -> None:
    assert list_dir(tmp_path) == "(空)"


def test_list_dir_missing_is_not_found(tmp_path: Path) -> None:
    with pytest.raises(WorkError) as exc:
        list_dir(tmp_path, "nope")
    assert code_of(exc) == ERROR_NOT_FOUND


def test_list_dir_on_a_file_is_not_a_directory(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    with pytest.raises(WorkError) as exc:
        list_dir(tmp_path, "f.txt")
    assert code_of(exc) == ERROR_NOT_A_DIRECTORY


def test_list_dir_truncates_at_the_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dsb.work.WORK_LIST_LIMIT", 2)
    for name in ("a", "b", "c"):
        (tmp_path / name).write_text(name, encoding="utf-8")
    listing = list_dir(tmp_path)
    assert listing.splitlines() == ["a", "b", "...(已截断,共 3 项)"]


def test_list_dir_refuses_out_of_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(WorkError) as exc:
        list_dir(root, "..")
    assert code_of(exc) == ERROR_OUT_OF_ROOT


# ---- read_text ----


def test_read_returns_the_whole_file(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("第一行\n第二行", encoding="utf-8")
    assert read_text(tmp_path, "f.txt") == "第一行\n第二行"


def test_read_truncates_with_an_annotation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dsb.work.WORK_READ_LIMIT", 5)
    (tmp_path / "f.txt").write_text("0123456789", encoding="utf-8")
    result = read_text(tmp_path, "f.txt")
    assert result.startswith("01234")
    assert "已截断,超出 5 字符" in result


def test_read_missing_is_not_found(tmp_path: Path) -> None:
    with pytest.raises(WorkError) as exc:
        read_text(tmp_path, "nope.txt")
    assert code_of(exc) == ERROR_NOT_FOUND


def test_read_on_a_directory_is_not_a_file(tmp_path: Path) -> None:
    (tmp_path / "d").mkdir()
    with pytest.raises(WorkError) as exc:
        read_text(tmp_path, "d")
    assert code_of(exc) == ERROR_NOT_A_FILE


def test_read_binary_reports_io_failed(tmp_path: Path) -> None:
    (tmp_path / "blob").write_bytes(b"\xff\xfe\x00\x01")
    with pytest.raises(WorkError) as exc:
        read_text(tmp_path, "blob")
    assert code_of(exc) == ERROR_IO_FAILED


def test_read_inside_dot_git_is_allowed(tmp_path: Path) -> None:
    """读侧不拦 ``.git``--只有写/改拦."""
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("[core]", encoding="utf-8")
    assert read_text(tmp_path, ".git/config") == "[core]"


# ---- write_text ----


def test_write_creates_parents_and_reports_bytes(tmp_path: Path) -> None:
    written = write_text(tmp_path, "a/b/c.txt", "你好")
    assert written == len("你好".encode())
    assert (tmp_path / "a" / "b" / "c.txt").read_text(encoding="utf-8") == "你好"


def test_write_overwrites(tmp_path: Path) -> None:
    write_text(tmp_path, "f.txt", "旧")
    write_text(tmp_path, "f.txt", "新")
    assert (tmp_path / "f.txt").read_text(encoding="utf-8") == "新"


def test_write_onto_a_directory_is_not_a_file(tmp_path: Path) -> None:
    (tmp_path / "d").mkdir()
    with pytest.raises(WorkError) as exc:
        write_text(tmp_path, "d", "x")
    assert code_of(exc) == ERROR_NOT_A_FILE


def test_write_into_dot_git_is_protected_and_leaves_nothing(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    original = tmp_path / ".git" / "config"
    original.write_text("原样", encoding="utf-8")
    with pytest.raises(WorkError) as exc:
        write_text(tmp_path, ".git/config", "改过了")
    assert code_of(exc) == ERROR_PROTECTED
    assert original.read_text(encoding="utf-8") == "原样"


def test_write_to_dot_git_itself_is_protected(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    with pytest.raises(WorkError) as exc:
        write_text(tmp_path, ".git", "x")
    assert code_of(exc) == ERROR_PROTECTED


def test_write_refuses_out_of_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(WorkError) as exc:
        write_text(root, "../escape.txt", "x")
    assert code_of(exc) == ERROR_OUT_OF_ROOT


# ---- edit_text ----


def test_edit_replaces_a_unique_match(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("alpha beta", encoding="utf-8")
    assert edit_text(tmp_path, "f.txt", "beta", "gamma") == 1
    assert (tmp_path / "f.txt").read_text(encoding="utf-8") == "alpha gamma"


def test_edit_without_a_match_leaves_the_file_alone(tmp_path: Path) -> None:
    target = tmp_path / "f.txt"
    target.write_text("alpha", encoding="utf-8")
    with pytest.raises(WorkError) as exc:
        edit_text(tmp_path, "f.txt", "nope", "x")
    assert code_of(exc) == ERROR_EDIT_NO_MATCH
    assert target.read_text(encoding="utf-8") == "alpha"


def test_edit_with_multiple_matches_leaves_the_file_alone(tmp_path: Path) -> None:
    target = tmp_path / "f.txt"
    target.write_text("x x", encoding="utf-8")
    with pytest.raises(WorkError) as exc:
        edit_text(tmp_path, "f.txt", "x", "y")
    assert code_of(exc) == ERROR_EDIT_NOT_UNIQUE
    assert target.read_text(encoding="utf-8") == "x x"


def test_edit_with_an_empty_old_string_is_no_match(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("abc", encoding="utf-8")
    with pytest.raises(WorkError) as exc:
        edit_text(tmp_path, "f.txt", "", "x")
    assert code_of(exc) == ERROR_EDIT_NO_MATCH


def test_edit_missing_file_is_not_found(tmp_path: Path) -> None:
    with pytest.raises(WorkError) as exc:
        edit_text(tmp_path, "nope.txt", "a", "b")
    assert code_of(exc) == ERROR_NOT_FOUND


def test_edit_inside_dot_git_is_protected(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    target = tmp_path / ".git" / "config"
    target.write_text("原样", encoding="utf-8")
    with pytest.raises(WorkError) as exc:
        edit_text(tmp_path, ".git/config", "原样", "改过")
    assert code_of(exc) == ERROR_PROTECTED
    assert target.read_text(encoding="utf-8") == "原样"


# ---- grep_tree ----


def test_grep_returns_relative_path_line_and_text(tmp_path: Path) -> None:
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "f.txt").write_text("第一行\n命中这行\n", encoding="utf-8")
    assert grep_tree(tmp_path, "命中", ".") == "sub/f.txt:2: 命中这行"


def test_grep_without_matches_says_so(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("abc", encoding="utf-8")
    assert grep_tree(tmp_path, "zzz") == "(无命中)"


def test_grep_skips_dot_git(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("needle", encoding="utf-8")
    (tmp_path / "f.txt").write_text("needle", encoding="utf-8")
    assert grep_tree(tmp_path, "needle") == "f.txt:1: needle"


def test_grep_skips_binary_files(tmp_path: Path) -> None:
    (tmp_path / "blob").write_bytes(b"needle\x00more")
    (tmp_path / "f.txt").write_text("needle", encoding="utf-8")
    assert grep_tree(tmp_path, "needle") == "f.txt:1: needle"


def test_grep_skips_symlinks_that_leave_the_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("needle", encoding="utf-8")
    (root / "link.txt").symlink_to(outside / "secret.txt")
    (root / "f.txt").write_text("needle", encoding="utf-8")
    assert grep_tree(root, "needle") == "f.txt:1: needle"


def test_grep_skips_oversized_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dsb.work.WORK_FILE_LIMIT", 4)
    (tmp_path / "big.txt").write_text("needle", encoding="utf-8")
    assert grep_tree(tmp_path, "needle") == "(无命中)"


def test_grep_truncates_long_lines(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dsb.work.WORK_LINE_LIMIT", 3)
    (tmp_path / "f.txt").write_text("needle", encoding="utf-8")
    assert grep_tree(tmp_path, "needle") == "f.txt:1: nee"


def test_grep_stops_at_the_hit_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dsb.work.WORK_GREP_LIMIT", 1)
    (tmp_path / "f.txt").write_text("x\nx\n", encoding="utf-8")
    lines = grep_tree(tmp_path, "x").splitlines()
    assert lines[0] == "f.txt:1: x"
    assert "已截断" in lines[-1]


def test_grep_bad_regex_is_bad_regex(tmp_path: Path) -> None:
    with pytest.raises(WorkError) as exc:
        grep_tree(tmp_path, "(")
    assert code_of(exc) == ERROR_BAD_REGEX


def test_grep_missing_path_is_not_found(tmp_path: Path) -> None:
    with pytest.raises(WorkError) as exc:
        grep_tree(tmp_path, "x", "nope")
    assert code_of(exc) == ERROR_NOT_FOUND


def test_grep_refuses_out_of_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(WorkError) as exc:
        grep_tree(root, "x", "..")
    assert code_of(exc) == ERROR_OUT_OF_ROOT


def test_grep_on_a_single_file(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("alpha\nbeta", encoding="utf-8")
    assert grep_tree(tmp_path, "beta", "f.txt") == "f.txt:2: beta"


# ---- protected_git ----


def test_protected_git_only_covers_dot_git(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    assert protected_git(tmp_path, tmp_path / ".git")
    assert protected_git(tmp_path, tmp_path / ".git" / "config")
    assert not protected_git(tmp_path, tmp_path / "gitignore")
    assert not protected_git(tmp_path, tmp_path / "src" / ".gitignore")


def test_protected_git_normalizes_paths_before_comparing(tmp_path: Path) -> None:
    """护栏不吃'两边指同一处,字面不同'的亏(如 root 是符号链接):未归一路径也必须挡住."""
    root = tmp_path / "root"
    root.mkdir()
    (root / ".git").mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(root, target_is_directory=True)
    assert protected_git(alias, alias / ".git" / "config")


# ---- resolve_work_root ----


def test_work_root_defaults_to_the_repo_root(monkeypatch: pytest.MonkeyPatch) -> None:
    from dsb.config import repo_root

    monkeypatch.delenv(WORK_ROOT_ENV_KEY, raising=False)
    assert resolve_work_root("") == repo_root()


def test_work_root_env_var_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(WORK_ROOT_ENV_KEY, str(tmp_path))
    assert resolve_work_root("") == tmp_path


def test_work_root_reads_dotenv_text(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(WORK_ROOT_ENV_KEY, raising=False)
    assert resolve_work_root(f"{WORK_ROOT_ENV_KEY}={tmp_path}") == tmp_path


def test_work_root_expands_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(WORK_ROOT_ENV_KEY, "~")
    assert resolve_work_root("") == Path.home()


def test_work_root_does_not_require_the_directory_to_exist(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    missing = tmp_path / "nope"
    monkeypatch.setenv(WORK_ROOT_ENV_KEY, str(missing))
    assert resolve_work_root("") == missing


# ---- work_tools ----


def tool_by_name(root: Path, name: str) -> Any:
    return next(tool for tool in work_tools(root) if tool.name == name)


def test_work_tools_are_exactly_the_five_and_no_shell(tmp_path: Path) -> None:
    names = [tool.name for tool in work_tools(tmp_path)]
    assert names == ["ls", "read", "grep", "write", "edit"]
    assert not {"shell", "bash", "sh", "exec", "run"} & set(names)


def test_work_tool_descriptions_name_the_work_directory(tmp_path: Path) -> None:
    for tool in work_tools(tmp_path):
        assert "[工作目录]" in tool.description


def test_missing_root_is_reported_clearly(tmp_path: Path) -> None:
    missing = tmp_path / "nope"
    payload, failed = tool_by_name(missing, "read").handler({"path": "a.txt"})
    assert failed is True
    assert payload["text"].startswith(ERROR_BAD_PATH)


def test_handlers_round_trip_through_the_tools(tmp_path: Path) -> None:
    tools = {tool.name: tool for tool in work_tools(tmp_path)}
    payload, failed = tools["write"].handler({"path": "a/b.txt", "content": "你好"})
    assert failed is False and "已写入" in payload["text"]

    payload, failed = tools["read"].handler({"path": "a/b.txt"})
    assert (payload["text"], failed) == ("你好", False)

    payload, failed = tools["ls"].handler({"path": "a"})
    assert (payload["text"], failed) == ("b.txt", False)

    payload, failed = tools["edit"].handler(
        {"path": "a/b.txt", "old_string": "你好", "new_string": "再见"}
    )
    assert (payload["text"], failed) == ("已替换 1 处:a/b.txt", False)
    assert (tmp_path / "a" / "b.txt").read_text(encoding="utf-8") == "再见"

    payload, failed = tools["grep"].handler({"pattern": "再见", "path": "a"})
    assert (payload["text"], failed) == ("a/b.txt:1: 再见", False)


def test_handler_out_of_root_is_a_failure_with_the_code_in_the_text(tmp_path: Path) -> None:
    payload, failed = tool_by_name(tmp_path, "read").handler({"path": "../x"})
    assert failed is True
    assert payload["text"].startswith(ERROR_OUT_OF_ROOT)


def test_handler_protected_write_is_a_failure(tmp_path: Path) -> None:
    payload, failed = tool_by_name(tmp_path, "write").handler(
        {"path": ".git/config", "content": "x"}
    )
    assert failed is True
    assert payload["text"].startswith(ERROR_PROTECTED)


def test_handler_missing_arguments_are_bad_path(tmp_path: Path) -> None:
    tools = {tool.name: tool for tool in work_tools(tmp_path)}
    for name, arguments in (
        ("read", {}),
        ("write", {"path": "x"}),
        ("edit", {"path": "x"}),
    ):
        payload, failed = tools[name].handler(arguments)
        assert failed is True, name
        assert payload["text"].startswith(ERROR_BAD_PATH), name


def test_handler_grep_pattern_must_be_a_string(tmp_path: Path) -> None:
    payload, failed = tool_by_name(tmp_path, "grep").handler({"pattern": 42})
    assert failed is True
    assert payload["text"].startswith(ERROR_BAD_REGEX)


def test_ls_accepts_a_missing_path(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    payload, failed = tool_by_name(tmp_path, "ls").handler({})
    assert (payload["text"], failed) == ("f.txt", False)


def test_arguments_type_is_a_mapping(tmp_path: Path) -> None:
    """处理器只认 ``Mapping``(与 :data:`dsb.mcp.ToolHandler` 一致)."""
    handler = tool_by_name(tmp_path, "ls").handler
    arguments: Mapping[str, Any] = {"path": "."}
    assert handler(arguments)[1] is False
