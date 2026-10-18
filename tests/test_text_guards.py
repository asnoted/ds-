"""两道文字守卫的纯半边: `punct`(中文标点换半角)与 `glyphs`(坏字).

这两件管**每一次提交**, 而它们的判据错了不会红: 只会**静默失明**(该报的说成"干净"),
或者把好文件改坏. 两条路都真踩过, 所以拿纯函数把话说死:

- `.py` 里的引号换成什么, 由它所在的**词法状态**决定 -- 双引号串内换 `\\"`, 单引号串内换
  `"`, 三引号串里挑**不属于定界符**的那个. 一律换直引号会把代码截断(f-string 尤其).
- 省略号与破折号是两个字符合一个符号: 一对换三个点, 不是六个.
- 认不出词法结构(源码本身有语法错)时按裸文本走, 不报错、不猜.
- **幂等**: 跑第二遍没有改动 -- 这是它敢接进提交闸的前提.
- 范围是**故意**收窄的(注释与用户可见提示语在 `scripts/` / `devtools/`, 其余代码不强制),
  而映射表所在的那个文件豁免自己 -- 不豁免, 工具会把自己的字典换掉, 当场变哑巴.

搬家中间态: 工具正在 `scripts/` 与 `devtools/dsbcli/tools/` 之间搬, 两种树都得能跑,
所以 `load_tool` 先按包找, 再按老路径兜底; 搬完把兜底那半删掉.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]

LEGACY = {
    "ascii_punct": ROOT / "scripts" / "ascii-punct.py",
    "stray_glyphs": ROOT / "scripts" / "check-stray-glyphs.py",
}

#: 坏字样例: 西里尔 / 平假名 / 谚文各取一个字母, 用码点写 -- 免得这份文件自己被自己报.
OTHER_SCRIPTS = (0x0410, 0x3042, 0xAC00)


def load_tool(name: str) -> ModuleType:
    try:
        return importlib.import_module(f"dsbcli.tools.{name}")
    except ModuleNotFoundError:
        legacy = LEGACY[name]
        if not legacy.is_file():
            raise
        spec = importlib.util.spec_from_file_location(f"{name}_legacy", legacy)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module


def test_py_quotes_follow_the_lexical_state() -> None:
    punct = load_tool("ascii_punct")
    assert punct.convert('x = "\u300cA,B\u300d"\n', ".py") == 'x = "\\"A,B\\""\n'
    assert punct.convert("y = '\u300cA,B\u300d'\n", ".py") == "y = '\"A,B\"'\n"
    comment = "# \u89c1\u300c\u529e\u6cd5\u300d\nz = 1\n"
    assert punct.convert(comment, ".py") == '# \u89c1"\u529e\u6cd5"\nz = 1\n'


def test_converted_python_still_compiles() -> None:
    punct = load_tool("ascii_punct")
    samples = [
        'x = "\u300cA,B\u300d\u3002\u2026"\n',
        "y = '\u300cA,B\u300d'\n",
        "s = '''\u300c\u300e\u300d\u300f'''\n",
        't = """\u300c\u300e\u300d\u300f"""\n',
        'f = f"\u8981\u300cA,B\u300d"\n',
        "m = '\u2026\u2026'  # \u2014\u2014 \u2026\n",
        "d = {'\u952e': '\u300c\u503c\u300d'}\n",
    ]
    for text in samples:
        out = punct.convert(text, ".py")
        compile(out, "<case>", "exec")
        assert punct.convert(out, ".py") == out, text


def test_an_fstring_stays_one_string() -> None:
    """f-string 认不出来就会把引号直换, 串当场截断 -- 换完还得是一个能求值的串."""
    punct = load_tool("ascii_punct")
    out = punct.convert('f = f"\u8981\u300cA,B\u300d"\n', ".py")
    assert eval(out.split("=", 1)[1].strip()) == '\u8981"A,B"'


def test_a_broken_source_is_not_guessed_at() -> None:
    punct = load_tool("ascii_punct")
    assert punct.py_regions("broken ( \u300c\n") == []
    assert isinstance(punct.convert("broken ( \u300c\n", ".py"), str)


def test_ellipsis_and_dash_fold_to_one_symbol() -> None:
    punct = load_tool("ascii_punct")
    assert punct.convert("\u2026\u2026\n", ".md") == "...\n"
    assert punct.convert("\u2026\n", ".md") == "...\n"
    assert punct.convert("\u2014\u2014\n", ".md") == "--\n"
    assert punct.convert("\u2014\n", ".md") == "--\n"


def test_markdown_goes_through_as_plain_text() -> None:
    punct = load_tool("ascii_punct")
    marked = "\u89c1\u300c\u529e\u6cd5\u300d\u3002\uff08\u4e00\uff09\uff1b\u2026\u2026\n"
    assert punct.convert(marked, ".md") == '\u89c1"\u529e\u6cd5".(\u4e00);...\n'


def test_only_these_files_are_in_scope() -> None:
    punct = load_tool("ascii_punct")
    root = Path("/repo")
    assert punct.in_scope(root / "docs" / "a.md", root)
    assert punct.in_scope(root / "scripts" / "a.py", root)
    for rel in (
        "tests/a.py",
        "src/a.ts",
        "entrypoints/a.ts",
        "dsb/a.py",
        "protocol/evidence/controls.json",
        ".agents/a.md",
        "vendor/a.py",
    ):
        assert not punct.in_scope(root / rel, root), rel


def test_the_dictionary_exempts_itself() -> None:
    """映射表里全是中文标点的字面字符: 不豁免, 工具会把自己的字典换掉, 静默失效."""
    punct = load_tool("ascii_punct")
    assert punct.in_scope(ROOT / punct.SELF, ROOT) is False


def test_glyph_scan_flags_the_other_scripts(tmp_path: Path) -> None:
    glyphs = load_tool("stray_glyphs")
    text = "\u6b63\u5e38\u4e00\u884c\n" + "".join(chr(code) for code in OTHER_SCRIPTS) + "\n"
    path = tmp_path / "sample.py"
    path.write_text(text, encoding="utf-8")
    assert glyphs.scan(path) == [
        (2, chr(OTHER_SCRIPTS[0]), "CYRILLIC CAPITAL LETTER A"),
        (2, chr(OTHER_SCRIPTS[1]), "HIRAGANA LETTER A"),
        (2, chr(OTHER_SCRIPTS[2]), "HANGUL SYLLABLE GA"),
    ]


def test_glyph_scan_leaves_our_own_alphabet_alone(tmp_path: Path) -> None:
    """汉字、中文标点、箭头框线数学符号都不算坏字(第 3 节说了要保留)."""
    glyphs = load_tool("stray_glyphs")
    text = (
        "\u3002\uff0c\u300c\u300d\u2026\u2026 \u2014 "
        "\u2192 \u2500 \u2260 \u2713 \u6c49\u5b57 ascii\n"
    )
    path = tmp_path / "sample.md"
    path.write_text(text, encoding="utf-8")
    assert glyphs.scan(path) == []


def test_glyph_scan_of_a_missing_file_is_empty() -> None:
    glyphs = load_tool("stray_glyphs")
    assert glyphs.scan(Path("/nonexistent/nowhere.txt")) == []
