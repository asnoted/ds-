"""工作工具:路径沙箱,五件行为,截断与上限,``.git`` 护栏,各错码(ADR-0009)."""

from __future__ import annotations

import re
import signal
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from dsb import work
from dsb.work import (
    ERROR_BAD_PATH,
    ERROR_BAD_RANGE,
    ERROR_BAD_REGEX,
    ERROR_EDIT_NO_MATCH,
    ERROR_EDIT_NOT_UNIQUE,
    ERROR_HINT,
    ERROR_IO_FAILED,
    ERROR_NOT_A_DIRECTORY,
    ERROR_NOT_A_FILE,
    ERROR_NOT_FOUND,
    ERROR_OUT_OF_ROOT,
    ERROR_PATTERN_TOO_SLOW,
    ERROR_PROTECTED,
    WORK_READ_BYTES,
    WORK_RESULT_CHARS,
    WORK_ROOT_ENV_KEY,
    WorkError,
    cap_result,
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

#: 工作工具那张表的家(ADR-0009): 码定义了却没写进这篇, 就是表漏了.
ADR_0009 = "0009-in-house-work-tools-and-permissions.md"


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


def test_list_dir_caps_the_whole_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """件数上限每维都不超时,整条仍可能很大:总量闸按整行砍,并在末行说怎么续."""
    monkeypatch.setattr("dsb.work.WORK_RESULT_CHARS", 100)
    for index in range(20):
        (tmp_path / f"{index:05d}").write_text("x", encoding="utf-8")
    result = list_dir(tmp_path)
    rows = result.splitlines()
    assert rows[:9] == [f"{index:05d}" for index in range(9)]
    assert rows[-1] == "...(整条超 100 字,已截断:给了前 9 行 / 共 20 行;换个更小的目录再列)"
    assert len(result) <= 100


# ---- read_text ----


def test_read_returns_the_whole_file_with_line_numbers(tmp_path: Path) -> None:
    """短文件一次读完:逐行带行号,脚注说读完,共几行(ADR-0010)."""
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


def test_read_page_stays_within_budget_when_the_text_is_astral(tmp_path: Path) -> None:
    """页预算按**扩展那把尺**(UTF-16 单元)量,星平面字算两个(ADR-0010).

    这里量法独立于 dsb 的实现(直接按 utf-16-le 编码数),四十行星平面字写成码点账只有
    一半,于是按码点算的页会在扩展侧量出两倍,超出去的那截被从尾巴上截掉--截掉的正是
    脚注.
    """
    line = "\U00020000" * 500
    (tmp_path / "f.txt").write_text("\n".join([line] * 40), encoding="utf-8")
    page = read_text(tmp_path, "f.txt")
    assert len(page.encode("utf-16-le")) // 2 <= WORK_READ_BYTES
    # 预算真的用上了大半(不是只退回一行),否则这条判据闭着眼也过.
    assert len(page.encode("utf-16-le")) // 2 > WORK_READ_BYTES // 2


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


def test_read_page_stays_within_the_same_budget_as_one_result(tmp_path: Path) -> None:
    """整页(行号、换行、脚注都在内)不超过页预算--扩展那道与它同数,越一个字就被截.

    这是 ADR-0010 量出来的那个洞:行宽 100 字时一页 16,154 字,扩展把脚注(``offset``
    的唯一来源)截掉了.
    """
    (tmp_path / "long.txt").write_text("\n".join("y" * 500 for _ in range(400)), encoding="utf-8")
    page = read_text(tmp_path, "long.txt", 1, 400)
    assert len(page) <= WORK_READ_BYTES
    assert page.splitlines()[-1].startswith("(字节预算截断")

    many = "\n".join("x" * 3 for _ in range(2_000))
    (tmp_path / "many.txt").write_text(many, encoding="utf-8")
    short = read_text(tmp_path, "many.txt", 1, 2_000)
    assert len(short) <= WORK_READ_BYTES
    assert "接着读:offset=" in short.splitlines()[-1]


@pytest.mark.parametrize("width", [60, 70, 74, 76, 78, 80, 90, 100, 120])
def test_read_page_stays_within_budget_across_line_widths(tmp_path: Path, width: int) -> None:
    """脚注留量要按**最长那一态**算:截断态比不截断多一句"字节预算截断".

    只按其中一态留量,页就正好差那几个字越线,被扩展从尾巴上截掉的正是脚注(宽 76 字 /
    共 200 行时越 7 个字).上面那两条(宽 500、宽 3)踩的是别处,踩不到这条边界.
    """
    (tmp_path / "f.txt").write_text("\n".join("x" * width for _ in range(200)), encoding="utf-8")
    page = read_text(tmp_path, "f.txt", 1, 200)
    assert len(page.encode("utf-16-le")) // 2 <= WORK_READ_BYTES
    assert page.splitlines()[-1].startswith("(")  # 末行仍是脚注--越线的代价正是把它截掉


def test_the_result_cap_is_one_read_page() -> None:
    """一条结果 = 一页:两个数同源(ADR-0010 的补记),改一个没改另一个就红."""
    assert WORK_RESULT_CHARS == WORK_READ_BYTES


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


def test_edit_on_a_directory_is_not_a_file(tmp_path: Path) -> None:
    """指着目录说"改这里"要回 not-a-file: 落到 io-failed 就把"路径不对"说成了"改坏了"."""
    (tmp_path / "d").mkdir()
    with pytest.raises(WorkError) as exc:
        edit_text(tmp_path, "d", "a", "b")
    assert code_of(exc) == ERROR_NOT_A_FILE


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


def test_grep_keeps_exactly_the_hit_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """上限是**含**那一条: 说"达上限 N"时手里就得正好 N 行--多给一行, 那句脚注就成了假话."""
    monkeypatch.setattr("dsb.work.WORK_GREP_LIMIT", 3)
    (tmp_path / "f.txt").write_text("\n".join("x" for _ in range(10)), encoding="utf-8")
    lines = grep_tree(tmp_path, "x").splitlines()
    assert lines[:-1] == [f"f.txt:{index + 1}: x" for index in range(3)]
    assert lines[-1] == "...(命中数达上限 3,已截断)"


def test_grep_caps_the_whole_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """命中数与单行长度都没超,整条仍可能很大(200 x 500 字):总量闸按整行砍."""
    monkeypatch.setattr("dsb.work.WORK_RESULT_CHARS", 150)
    (tmp_path / "f.txt").write_text("\n".join(f"x{index}" for index in range(20)), encoding="utf-8")
    result = grep_tree(tmp_path, "x")
    rows = result.splitlines()
    assert rows[:7] == [f"f.txt:{index + 1}: x{index}" for index in range(7)]
    assert (
        rows[-1] == "...(整条超 150 字,已截断:给了前 7 行 / 共 20 行;收窄模式,或指定 path 分几次搜)"
    )
    assert len(result) <= 150


def test_a_capped_result_leaves_room_for_its_last_line() -> None:
    """整条(连末句)不超过 :data:`WORK_RESULT_CHARS`:末句也占额度.

    这些行宽是量出来的(ADR-0010):末句不算进去时,64/80/100/120 字各越线 24~41 字,
    **而扩展就是从尾巴上截的**--截掉的正好是"怎么续"那句.
    """
    for width in (64, 80, 100, 120, 300):
        capped = cap_result("\n".join("x" * width for _ in range(1_000)), "换个更小的目录再列")
        assert len(capped) <= WORK_RESULT_CHARS, width
        assert capped.splitlines()[-1].startswith("...(整条超"), width


def test_a_capped_result_still_gives_one_line_when_the_budget_is_tiny(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """预算小到连末句都放不下时**仍然给一行**:与 `read` 那条'宁可超预算也给那一行'同一条."""
    monkeypatch.setattr("dsb.work.WORK_RESULT_CHARS", 10)
    assert cap_result("\n".join(["aaaa"] * 3), "换个更小的目录再列").splitlines()[0] == "aaaa"


def test_a_single_overlong_line_is_cut_inside_the_line() -> None:
    """第一行自己就超预算时在行内砍:整行照给等于没闸(那一行就能几十万字).

    失败回执正是这一种:``detail`` 里回显的是模型自己写进来的模式串或路径.
    """
    capped = cap_result("x" * (WORK_RESULT_CHARS * 2), "换个更小的目录再列")
    assert len(capped.encode("utf-16-le")) // 2 <= WORK_RESULT_CHARS
    assert capped.startswith("x" * 100)
    assert "已截断" in capped
    assert f"原文 {WORK_RESULT_CHARS * 2} 字" in capped


def test_a_cut_line_counts_utf16_units() -> None:
    """行内砍也按扩展那把尺:一整个星平面字占两个单元,砍出来的整条不超预算(ADR-0010)."""
    capped = cap_result("\U00020000" * WORK_RESULT_CHARS, "把参数改短或改窄再试")
    assert len(capped.encode("utf-16-le")) // 2 <= WORK_RESULT_CHARS
    assert "已截断" in capped


def test_a_failed_call_with_a_huge_detail_still_fits_the_result_budget(tmp_path: Path) -> None:
    """失败回执与成功正文过同一道闸:回显的模式串是模型写的,一行能几十万字."""
    pattern = "(" + "a" * (WORK_RESULT_CHARS * 2)
    payload, failed = tool_by_name(tmp_path, "grep").handler({"pattern": pattern})
    assert failed is True
    body = payload["text"]
    assert body.startswith(f"{ERROR_BAD_REGEX}(正则")
    assert len(body.encode("utf-16-le")) // 2 <= WORK_RESULT_CHARS
    assert ERROR_HINT in body


def test_grep_bad_regex_is_bad_regex(tmp_path: Path) -> None:
    with pytest.raises(WorkError) as exc:
        grep_tree(tmp_path, "(")
    assert code_of(exc) == ERROR_BAD_REGEX


def test_grep_gives_up_on_exponential_backtracking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """墙钟这道闸(ADR-0010):40 个 ``a`` 后面挂 ``(a+)+b`` 是指数回溯,没闸就回不来."""
    monkeypatch.setattr("dsb.work.WORK_GREP_DEADLINE", 0.3)
    (tmp_path / "big.txt").write_text("a" * 40 + "!\n", encoding="utf-8")
    started = time.monotonic()
    with pytest.raises(WorkError) as exc:
        grep_tree(tmp_path, "(a+)+b")
    assert code_of(exc) == ERROR_PATTERN_TOO_SLOW
    assert time.monotonic() - started < 5


def test_the_wall_clock_is_disarmed_when_the_search_finishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """墙钟收工要撤: 不撤, 这一次搜索的闹铃过几秒会砸在**别人**头上(平白一件 pattern-too-slow).

    闹铃是一次性的(``ITIMER_REAL``): 这一次搜得比墙钟快, 不走那一下撤掉它, 它就在几秒后
    落在当前正在跑的随便哪件事上. 这里先自己装一个只记数的处理器--于是"没撤"当场看得见,
    而不是把测试进程整个送走(装过处理器也是 ``_deadline`` 会还原的那一个).
    """
    monkeypatch.setattr("dsb.work.WORK_GREP_DEADLINE", 0.2)
    rang: list[bool] = []
    previous = signal.signal(signal.SIGALRM, lambda *_args: rang.append(True))
    try:
        (tmp_path / "f.txt").write_text("hit\n", encoding="utf-8")
        assert grep_tree(tmp_path, "hit") == "f.txt:1: hit"
        time.sleep(0.5)
        assert rang == []
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


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


@pytest.mark.parametrize("field", ["offset", "limit"])
def test_a_bool_is_not_an_integer_for_the_page_arguments(tmp_path: Path, field: str) -> None:
    """``true`` 在 Python 里是 int 的子类: 收下它等于把"翻下一页"当成 ``offset=1``."""
    (tmp_path / "f.txt").write_text("a\n", encoding="utf-8")
    payload, failed = tool_by_name(tmp_path, "read").handler({"path": "f.txt", field: True})
    assert failed is True
    assert payload["text"].startswith(ERROR_BAD_PATH)
    assert field in payload["text"]


def test_grep_tool_reports_a_pattern_that_blew_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """模型那侧拿到的是一句能照着改的话,不是一个没头没尾的 ``tool-timeout``."""
    monkeypatch.setattr("dsb.work.WORK_GREP_DEADLINE", 0.3)
    (tmp_path / "big.txt").write_text("a" * 40 + "!\n", encoding="utf-8")
    payload, failed = tool_by_name(tmp_path, "grep").handler({"pattern": "(a+)+b"})
    assert failed is True
    assert payload["text"].startswith(f"{ERROR_PATTERN_TOO_SLOW}(模式")
    assert "缩小范围" in payload["text"]


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


@pytest.mark.docs
def test_every_code_is_catalogued_in_the_adr() -> None:
    """ADR-0009 那张表读起来是完整的一张: ``dsb/work.py`` 里定义的每个码都得在篇里点到名.

    反方向(篇里点名的码在仓里存在)由 ADR 的点名守卫管; 这一条管的是"码定义了、表里没写"
    -- 2026-10-17 的教训(中继事件册子漏了四条, 两边都绿).
    """
    # 只看"长得像码"的值: ``ERROR_HINT`` 是写给人看的一句话, 不在册子里.
    codes = sorted(
        value
        for name, value in vars(work).items()
        if name.startswith("ERROR_")
        and isinstance(value, str)
        and re.fullmatch(r"[a-z][a-z0-9-]*", value)
    )
    # 提取坏掉时别给假绿(空集合会让下面那条断言过得很轻松).
    assert ERROR_OUT_OF_ROOT in codes and ERROR_PATTERN_TOO_SLOW in codes
    adr = (Path(__file__).resolve().parents[1] / "docs" / "adr" / ADR_0009).read_text(
        encoding="utf-8"
    )
    missing = [code for code in codes if code not in adr]
    assert not missing, f"ADR-0009 那张表少点名的码: {missing}"
