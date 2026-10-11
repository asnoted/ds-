#!/usr/bin/env python3
"""把中文标点换成半角 -- 只管自家代码与文档, 不碰 vendored 与数据文件.

**为什么要有这个工具**: 本仓不用中文标点(见 `CODING_STANDARDS.md` 第 3 节).
规矩光写在文档里会漂, 所以它既能改也能查(`--check`), 后者接进 `pnpm quality`,
让违反规矩的提交在 CI 里就红, 而不是等 review 时被人眼抓到.

**范围**: 只改 `.md` `.ts` `.tsx` `.js` `.mjs` `.py` 里本仓自己写的那些.
以下一律不碰, 且各有理由:

- `.agents/` `vendor/` -- 别人家的代码, 手改会被升级冲掉(AGENTS.md 记着).
- `protocol/evidence/` -- 真机抓下来的**原件**. 改它等于把"录到的现实"
  改成"我们希望它长什么样", ADR-0018 的对账就失去意义.
- `protocol/fixtures/` `.json` `.html` `.svg` `.toml` `.yaml` `.sh` --
  契约样例与配置, 改字面等于改字节, 会连带改测试断言, 而它们不是文档与代码.

**为什么必须认字符串字面量**: `error("发送「继续」")` 直接换掉引号会变成
`error("发送"继续"")` -- 代码当场断掉. 所以在代码文件里, 引号该换成什么由
**它所在的词法状态**决定: 双引号字符串内换 `\"` (源码合法), 单引号字符串内
换成 `"`, 注释与模板串里换直引号. 裸代码(标识符/关键字)一个字符都不碰.

**按索引走而不是重建源码**: 早先那版按 token 重新拼接, 结果把 token 之间的
空格吞了(`X = 1` 变成 `X=1`). 现在只改"要换的那些字符", 其余字节原样保留.

**幂等**: 跑第二遍没有改动, 所以接进 pre-commit 安全.
"""

from __future__ import annotations

import argparse
import subprocess
import tokenize
from pathlib import Path

TAG = "[ascii-punct]"

# 单字符替身.
PAIRS: dict[str, str] = {
    "。": ".",  # 。
    "，": ",",  # ，
    "、": ",",  # 、  顿号
    "；": ";",  # ；
    "：": ":",  # ：
    "？": "?",  # ？
    "！": "!",  # ！
    "（": "(",  # （
    "）": ")",  # ）
    "《": "<",  # 《
    "》": ">",  # 》
    "【": "[",  # 【
    "】": "]",  # 】
    "〔": "[",  # 〔
    "〕": "]",  # 〕
    "～": "~",  # ～
    "·": "/",  # ·  间隔号
}

# 省略号与破折号是"**两个字符才构成一个符号**": 中文写 `……` 与 `--`,
# 但单字 `…` 也常见. 不折叠的话 `……` 会变成六个点, 那是错的.
SELF_PAIRS: dict[str, str] = {
    "…": "...",  # …  ……
    "—": "--",  # —  ——
}

# 全角块里剩下的标点与符号. 中文正文里这些混着半角用, 视觉上几乎看不出差别,
# 留着只会让"全仓半角"这条规矩有例外.
FULLWIDTH: dict[str, str] = {
    "．": ".",  # ．
    "／": "/",  # ／
    "＂": '"',  # ＂
    "＇": "'",  # ＇
    "＄": "$",  # ＄
    "＠": "@",  # ＠
    "［": "[",  # ［
    "］": "]",  # ］
    "＼": "\\",  # ＼
    "＾": "^",  # ＾
    "＿": "_",  # ＿
    "｀": "`",  # ｀
    "｛": "{",  # ｛
    "｜": "|",  # ｜
    "｝": "}",  # ｝
    "＋": "+",  # ＋
    "－": "-",  # －
    "＜": "<",  # ＜
    "＝": "=",  # ＝
    "＞": ">",  # ＞
    "％": "%",  # ％
    "＊": "*",  # ＊
    "＆": "&",  # ＆
    "＃": "#",  # ＃
}

# **有意不换**的(它们不是标点): 箭头 `→ ← ↔`, 框线 `─ │ ├ └`, 数学
# `≠ ≥ ≈ ∈ −`, `✓ ★`. 框线是 ASCII 流程图的骨架, 换成 ASCII 框线会把图画烂;
# 箭头与数学符号换成 `->` `!=` 会污染散文. CODING_STANDARDS.md 第 3 节写了这条.

# 成对引号. 三列分别对应: 双引号字符串内 / 单引号字符串内 / 注释与模板串内.
# 「」用直双引号, 『』用直单引号 -- 这样嵌套还能读出层次.
QUOTE_PAIRS: dict[str, tuple[str, str, str]] = {
    "「": ('\\"', '"', '"'),  # 「
    "」": ('\\"', '"', '"'),  # 」
    "“": ('\\"', '"', '"'),  # “
    "”": ('\\"', '"', '"'),  # ”
    "『": ("'", "\\'", "'"),  # 『
    "』": ("'", "\\'", "'"),  # 』
    "‘": ("'", "\\'", "'"),  # ‘
    "’": ("'", "\\'", "'"),  # ’
}

# 列索引: 0=双引号串内 1=单引号串内 2=注释/模板串/裸文本
PLAIN = 2

ALL_CHARS = set(PAIRS) | set(SELF_PAIRS) | set(FULLWIDTH) | set(QUOTE_PAIRS)

SCOPE_SUFFIX = {".md", ".ts", ".tsx", ".js", ".mjs", ".py"}
NEEDS_LEX = {".ts", ".tsx", ".js", ".mjs", ".py"}
EXCLUDE_PREFIX = (".agents/", "vendor/", "node_modules/", ".output/", ".wxt/", "dist/")

# 本文件豁免自己: 它的映射表**必须**含中文标点的字面字符(键就是 `"。": "."`).
# 被自己的工具扫一遍, 那些键会变成 `"."`, 映射随之失效 -- 工具当场变成哑巴,
# 而且是静默失效(它会报"改好 0 个文件", 看起来像任务已完成).
SELF = "scripts/ascii-punct.py"


def quote_col(kind: str, delim: str) -> int:
    """引号该用哪一列替身."""
    if kind == "string":
        if delim == '"':
            return 0
        if delim == "'":
            return 1
        return PLAIN  # 模板串 ` 与 Python 的三引号串, 裸双引号本来就合法
    return PLAIN


def py_regions(text: str) -> list[tuple[int, int, str, str]]:
    """用 tokenize 标出 (start, end, kind, delim); 源码坏了就返回空(=不改)."""
    lines = text.splitlines(keepends=True)
    offsets: list[int] = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line)

    def at(row: int, col: int) -> int:
        idx = row - 1
        if idx < 0 or idx >= len(offsets):
            return len(text)
        return min(offsets[idx] + col, len(text))

    regions: list[tuple[int, int, str, str]] = []
    try:
        toks = tokenize.generate_tokens(iter(lines).__next__)
        # Python 3.13 起(PEP 701)f-string 不再是单个 STRING token, 而是
        # FSTRING_START / FSTRING_MIDDLE / FSTRING_END 三段. 不单独认它的话,
        # f-string 里的内容会落进"裸代码"分支, 引号直换 -> 字符串当场截断
        # (f"... 要「A,B」..." 变成 f"... 要"A,B"..."). 这里按配对把整段圈成字符串区.
        f_depth = 0
        f_start = 0
        f_delim = ""
        for tok in toks:
            if tok.type == tokenize.STRING:
                s = tok.string
                delim = s[:3] if s[:3] in ('"""', "'''") else s[:1]
                regions.append((at(*tok.start), at(*tok.end), "string", delim))
            elif tok.type == tokenize.COMMENT:
                regions.append((at(*tok.start), at(*tok.end), "comment", ""))
            elif tok.type == getattr(tokenize, "FSTRING_START", -1):
                if f_depth == 0:
                    f_start, f_delim = at(*tok.start), tok.string[-1:]
                f_depth += 1
            elif tok.type == getattr(tokenize, "FSTRING_END", -1):
                f_depth = max(0, f_depth - 1)
                if f_depth == 0:
                    regions.append((f_start, at(*tok.end), "string", f_delim))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return []
    return regions


def _regex_end(text: str, i: int) -> int:
    """`i` 处的 `/` 若是正则起始, 返回它(含 flags)之后的下标; 否则 -1.

    **必须处理正则**: 正则里可以出现引号(`/".length"/` 这种), 扫描器若把它
    当字符串起始, 就会一路吞到下一个引号 -- 实测 `src/lib/answer.ts` 里的
    `/".length, -"/` 吞掉了 1641 个字符, 后面真正的注释全被误判成字符串.
    判据用老办法: 前一个有效字符若是运算符/左括号, `/` 就是正则的开头.
    """
    prev = ""
    for k in range(i - 1, -1, -1):
        if not text[k].isspace():
            prev = text[k]
            break
    if prev and (prev.isalnum() or prev in ")]_."):
        return -1  # 除号, 不是正则
    j, in_class = i + 1, False
    while j < len(text):
        c = text[j]
        if c == "\\":
            j += 2
            continue
        if c == "\n":
            return -1
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            j += 1
            while j < len(text) and text[j].isalpha():
                j += 1
            return j
        j += 1
    return -1


def ts_regions(text: str) -> list[tuple[int, int, str, str]]:
    """给 .ts/.js 标出字符串与注释的区间 (start, end, kind, delim)."""
    regions: list[tuple[int, int, str, str]] = []
    i, n, start, delim = 0, len(text), 0, ""
    while i < n:
        c = text[i]
        if delim:
            if c == "\\":
                i += 2
                continue
            if c == delim:
                regions.append((start, i + 1, "string", delim))
                delim = ""
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            j = n if j == -1 else j
            regions.append((i, j, "comment", ""))
            i = j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            j = n if j == -1 else j + 2
            regions.append((i, j, "comment", ""))
            i = j
            continue
        if c == "/":
            j = _regex_end(text, i)
            if j > 0:
                i = j  # 正则整体跳过, 别让里面的引号改写状态
                continue
        if c in "'\"`":
            delim, start = c, i
        i += 1
    if delim:  # 没闭合的字符串, 也要覆盖到, 别漏改
        regions.append((start, n, "string", delim))
    return regions


def convert(text: str, suffix: str) -> str:
    if suffix == ".py":
        regions = py_regions(text)
    elif suffix in NEEDS_LEX:
        regions = ts_regions(text)
    else:
        regions = []
    # 没有 region 就整段裸文本(.md); 源码坏了 py_regions 返回空, 那种情况按裸文本
    # 处理仍比留着中文标点好, 且不碰定界符.
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        # 省略号/破折号: 成对时算一个, 单独出现时也算一个
        for src, repl in SELF_PAIRS.items():
            if ch == src:
                out.append(repl)
                i += 2 if i + 1 < n and text[i + 1] == src else 1
                break
        else:
            kind, delim = "bare", ""
            for s, e, k, d in regions:
                if s <= i < e:
                    kind, delim = k, d
                    break
            if ch in PAIRS:
                out.append(PAIRS[ch])
            elif ch in FULLWIDTH:
                out.append(FULLWIDTH[ch])
            elif ch in QUOTE_PAIRS:
                col = quote_col(kind, delim)
                if col == PLAIN and delim in ('"""', "'''"):
                    # Python 三引号串: 直引号紧贴定界符会把它提前闭合
                    # ("""x"y"""" -> 结尾四个引号), 所以用**不属于定界符**的那个.
                    out.append("'" if delim == '"""' else '"')
                else:
                    out.append(QUOTE_PAIRS[ch][col])
            else:
                out.append(ch)
            i += 1
    return "".join(out)


def in_scope(path: Path, root: Path) -> bool:
    rel = path.relative_to(root).as_posix()
    if rel == SELF or rel.startswith(EXCLUDE_PREFIX):
        return False
    return path.suffix in SCOPE_SUFFIX


def tracked_files(root: Path) -> list[Path]:
    """只取 git 跟踪的文件.

    别用 `rglob("*")`: 它会把 `node_modules` / `.venv` / `.git` 全走一遍(慢到超时),
    而且会碰到未跟踪的文件——那不是"本仓自己写的代码",改了也没法进版本库.
    """
    try:
        names = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            capture_output=True,
            check=True,
            text=False,
        ).stdout.decode("utf-8")
    except (OSError, subprocess.CalledProcessError):
        return []
    return [root / n for n in names.split("\0") if n]


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--check", action="store_true", help="只查不改; 发现中文标点就退出码 1")
    ap.add_argument("--root", default=".", help="仓库根(默认当前目录)")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    offenders: list[str] = []
    changed = 0

    for path in tracked_files(root):
        if not in_scope(path, root):
            continue
        try:
            original = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if not (set(original) & ALL_CHARS):
            continue
        updated = convert(original, path.suffix)
        if updated == original:
            continue
        if args.check:
            offenders.append(path.relative_to(root).as_posix())
        else:
            path.write_text(updated, encoding="utf-8")
            changed += 1

    if args.check:
        if offenders:
            print(f"{TAG} 发现 {len(offenders)} 个文件还有中文标点:")
            for name in offenders:
                print(f"  {name}")
            print(f"{TAG} 跑 `uv run scripts/ascii-punct.py` 修, 或看 CODING_STANDARDS.md 第 3 节.")
            raise SystemExit(1)
        print(f"{TAG} 干净: 范围内没有中文标点.")
        return

    print(f"{TAG} 改好 {changed} 个文件.")


if __name__ == "__main__":
    main()
