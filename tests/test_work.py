"""工作工具:路径沙箱,五件行为,截断与上限,``.git`` 护栏,各错码(ADR-0012)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from dsb.work import (
    ERROR_BAD_PATH,
    ERROR_BAD_RANGE,
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


def test_read_returns_the_whole_file_with_line_numbers(tmp_path: Path) -> None:
    """短文件一次读完:逐行带行号,脚注说读完,共几行(ADR-0026)."""
    (tmp_path / "f.txt").write_text("第一行\n第二行", encoding="utf-8")
    assert read_text(tmp_path, "f.txt") == "1: 第一行\n2: 第二行\n(文件读完:共 2 行)"


def test_read_says_how_to_continue_when_the_page_ends_early(tmp_path: Path) -> None:
    """页按行数到头,文件还有 → 脚注给下一读的 offset(原来只写'已截断')."""
    (tmp_path / "f.txt").write_text("\n".join(f"L{i}" for i in range(1, 11)), encoding="utf-8")
    result = read_text(tmp_path, "f.txt", 4, 3)
    assert result == "4: L4\n5: L5\n6: L6\n(第 4-6 行 / 共 10 行,接着读:offset=7)"


def test_read_pages_by_line_and_the_footer_tracks_where_it_is(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("\n".join(f"L{i}" for i in range(1, 11)), encoding="utf-8")
    assert (
        read_text(tmp_path, "f.txt", 8, 2)
        == "8: L8\n9: L9\n(第 8-9 行 / 共 10 行,接着读:offset=10)"
    )
    assert read_text(tmp_path, "f.txt", 10, 2) == "10: L10\n(文件读完:共 10 行)"


def test_read_offset_past_the_end_says_so_instead_of_an_empty_page(tmp_path: Path) -> None:
    """offset 越界要说清是越界(模型据此改问法),不是给一页空正文."""
    (tmp_path / "f.txt").write_text("a\nb", encoding="utf-8")
    assert read_text(tmp_path, "f.txt", 99, 3) == "(空:offset=99 超出文件总行数 2)"


def test_read_limit_is_capped_at_the_maximum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """limit 超上限按上限给(不是报错):模型把 99999 写进来也能拿到一页."""
    (tmp_path / "f.txt").write_text("\n".join(f"L{i}" for i in range(1, 6)), encoding="utf-8")
    monkeypatch.setattr("dsb.work.WORK_READ_MAX_LINES", 2)
    assert (
        read_text(tmp_path, "f.txt", 1, 999_999)
        == "1: L1\n2: L2\n(第 1-2 行 / 共 5 行,接着读:offset=3)"
    )


def test_read_rejects_a_nonsense_offset_or_limit(tmp_path: Path) -> None:
    """从 1 起,至少 1 行:这两个是入参约定,越界当错码回,不静默改成别的."""
    (tmp_path / "f.txt").write_text("a", encoding="utf-8")
    for kwargs in ({"offset": 0}, {"limit": 0}, {"limit": -3}):
        with pytest.raises(WorkError) as exc:
            read_text(tmp_path, "f.txt", **kwargs)  # type: ignore[arg-type]
        assert code_of(exc) == ERROR_BAD_RANGE


def test_read_byte_budget_cuts_the_page_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """预算砍在半路要说'预算截断'--模型得知道这一页本身不完整.

    这里得是**多行**文件:单行时那一行本来就能放完(见下面那条'宁可超预算也给那一行'),
    预算砍不出东西来.
    """
    monkeypatch.setattr("dsb.work.WORK_READ_BYTES", 20)
    (tmp_path / "f.txt").write_text("a" * 8 + "\n" + "b" * 8, encoding="utf-8")
    assert (
        read_text(tmp_path, "f.txt")
        == "1: aaaaaaaa\n(字节预算截断,第 1-1 行 / 共 2 行,接着读:offset=2)"
    )


def test_read_marks_an_overlong_line_instead_of_silently_shortening_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """单行超限另标:静默截断会让模型以为那就是整行."""
    monkeypatch.setattr("dsb.work.WORK_READ_LINE_LIMIT", 5)
    (tmp_path / "f.txt").write_text("abcdefghij", encoding="utf-8")
    assert read_text(tmp_path, "f.txt") == "1: abcde...(本行超 5 字)\n(文件读完:共 1 行)"


def test_read_does_not_count_an_extra_line_when_the_file_ends_with_a_newline(
    tmp_path: Path,
) -> None:
    """以换行结尾的文件**不多算一行**.

    真机踩到:624 行的文件被报成 625 行(``"a\\nb\\n"`` 切出 3 段而文件只有 2 行),
    而模型会照抄脚注里那个总数--**总数错就是模型眼里的文件错**.
    """
    (tmp_path / "f.txt").write_text("a\nb\n", encoding="utf-8")
    assert read_text(tmp_path, "f.txt") == "1: a\n2: b\n(文件读完:共 2 行)"


def test_read_does_not_count_an_extra_line_when_it_does_not_end_with_one(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_text("a\nb", encoding="utf-8")
    assert read_text(tmp_path, "f.txt") == "1: a\n2: b\n(文件读完:共 2 行)"


def test_read_still_counts_blank_lines_in_the_middle(tmp_path: Path) -> None:
    """中间的空行是行,不该被 join 掉."""
    (tmp_path / "f.txt").write_text("a\n\nb", encoding="utf-8")
    assert read_text(tmp_path, "f.txt") == "1: a\n2: \n3: b\n(文件读完:共 3 行)"


def test_read_on_an_empty_file_says_zero_lines(tmp_path: Path) -> None:
    (tmp_path / "empty.txt").write_text("", encoding="utf-8")
    assert read_text(tmp_path, "empty.txt") == "(空:offset=1 超出文件总行数 0)"


def test_read_always_yields_a_page_even_when_the_budget_is_tiny(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """预算小到一行都放不下时**仍然给那一行**:空页对模型最没用,它连翻到哪都不知道."""
    monkeypatch.setattr("dsb.work.WORK_READ_BYTES", 2)
    (tmp_path / "f.txt").write_text("abcdef\nsecond", encoding="utf-8")
    assert (
        read_text(tmp_path, "f.txt")
        == "1: abcdef\n(字节预算截断,第 1-1 行 / 共 2 行,接着读:offset=2)"
    )


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
    assert read_text(tmp_path, ".git/config") == "1: [core]\n(文件读完:共 1 行)"


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
    assert (payload["text"], failed) == ("1: 你好\n(文件读完:共 1 行)", False)

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
