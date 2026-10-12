#!/usr/bin/env python3
"""把中文标点换成半角 -- 管全部 `.md` 与 `scripts/` 下的 `.py`.

**为什么要有这个工具**: 本仓不用中文标点(见 `docs/CODING_STANDARDS.md` 第 3 节).
规矩光写在文档里会漂, 所以它既能改也能查(`--check`), 后者接进 `pnpm quality`,
让违反规矩的提交在 CI 里就红, 而不是等 review 时被人眼抓到.

**范围**(2026-10-11 用户收窄过):

- **全部 `.md`** -- 仓库的散文主体, 规则的主要对象.
- **`scripts/` 下的 `.py`** -- 注释与用户可见提示语最常被读, 值得一并管.
- **其余代码不管**: `src/` `entrypoints/` `dsb/` `tests/`. 早先扫过一遍,
  存量保持已扫(见下), 但**不再强制** -- 范围小的东西才守得住, 守卫一旦
  覆盖面太大就没人愿意维护它, 那才是真失效.

一律不碰的, 且各有理由:

- `.agents/` `vendor/` -- 别人家的代码, 手改会被升级冲掉(AGENTS.md 记着).
- `protocol/evidence/` -- 真机抓下来的**原件**. 改它等于把"录到的现实"
  改成"我们希望它长什么样", ADR-0018 的对账就失去意义.
- `protocol/fixtures/` `.json` `.html` `.svg` `.toml` `.yaml` `.sh` --
  契约样例与配置, 改字面等于改字节, 会连带改测试断言, 而它们不是文档与代码.

**为什么必须认字符串字面量**: `error("发送「继续」")` 直接换掉引号会变成
`error("发送"继续"")` -- 代码当场断掉. 所以在 `.py` 里, 引号该换成什么由
**它所在的词法状态**决定: 双引号字符串内换 `\"` (源码合法), 单引号字符串内
换成 `"`, 注释与三引号串里换直引号. 裸代码(标识符/关键字)一个字符都不碰.

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
# 箭头与数学符号换成 `->` `!=` 会污染散文. docs/CODING_STANDARDS.md 第 3 节写了这条.

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

SCOPE_SUFFIX = {".md"}
CODE_PREFIX = "scripts/"  # scripts/ 下的 .py 也管: 它们的注释与用户可见提示语最常被读
CODE_SUFFIX = {".py"}
NEEDS_LEX = {".py"}
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


def convert(text: str, suffix: str) -> str:
    regions = py_regions(text) if suffix in NEEDS_LEX else []
    # .md 整段按裸文本处理; 源码坏了 py_regions 返回空, 那种情况也按裸文本处理 --
    # 留着中文标点总比留下一个不能修的文件好, 且不碰定界符.
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
    if path.suffix in SCOPE_SUFFIX:
        return True
    return rel.startswith(CODE_PREFIX) and path.suffix in CODE_SUFFIX


def tracked_files(root: Path) -> list[Path]:
    """取 git 认得的文件: 已跟踪的 + 未跟踪但没被 ignore 的.

    两个坑都在这里踩过:

    - 别用 `rglob("*"): 它会把 `node_modules` / `.venv` / `.git` 全走一遍
      (慢到超时), 还会碰到未跟踪但属于本机的东西.
    - 但**光用 `git ls-files` 也错**: 它只列已跟踪的, 而本文件最该处理的
      恰恰是**刚写出来的**新文件. docs/CODING_STANDARDS.md 就是这么漏过去的 --
      建分支时它是未跟踪的, 转换器跳过它, 提交时带着中文标点进了 main,
      而转换器自己当时报的是"干净". 加 `--others --exclude-standard`
      补上未跟踪的, 同时仍被 .gitignore 挡住的(node_modules / .venv /
    dsweb/bundle)不会进来.
    """
    try:
        names = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            capture_output=True,
            check=True,
            text=False,
        ).stdout.decode("utf-8")
    except (OSError, subprocess.CalledProcessError):
        return []
    seen: set[str] = set()
    out: list[Path] = []
    for name in names.split("\0"):
        if name and name not in seen:
            seen.add(name)
            out.append(root / name)
    return out


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
            print(
                f"{TAG} 跑 `uv run scripts/ascii-punct.py` 修, "
                "或看 `docs/CODING_STANDARDS.md` 第 3 节."
            )
            raise SystemExit(1)
        print(f"{TAG} 干净: 范围内没有中文标点.")
        return

    print(f"{TAG} 改好 {changed} 个文件.")


if __name__ == "__main__":
    main()
