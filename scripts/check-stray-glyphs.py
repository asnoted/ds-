#!/usr/bin/env python3
"""查文档与代码里的"坏字" -- 不属于本仓语言体系,却也不该出现的字符.

**为什么要有这个工具**: 2026-10-11 我往 `docs/CODING_STANDARDS.md` 补一段话, 里面混进
了一个谚文字符, 全程没察觉, 是提交前逐段扫非中日韩字符才发现的. (这里刻意**不**
写出那个字符的字面--本文件自己也在检查范围内, 写出来就会被自己报.)

**为什么需要它**: 文档里的坏字**没有编译器**. 代码里混进一个异种文字, `tsc` /
`ruff` 会立刻红; 混进 `.md` 只有读的人会撞上, 而且往往要很久以后才发现.
见 `docs/CODING_STANDARDS.md` 第 3 节末尾那条同源的教训.

**它查什么**: 汉字与 ASCII 之外,且**不属于中文标点**的那些文字体系字符
(谚文/假名/西里尔/希腊/阿拉伯/希伯来/泰/天城/亚美尼亚/格鲁吉亚). 箭头 `→`,
框线 `─`,数学 `≠` 与中文标点都不算坏字, 那些第 3 节明确说了要保留.

**接进 `pnpm quality:ci`**(守卫只在 CI 跑), 跟 `ascii-punct.py --check` 一样是硬判据.
"""

from __future__ import annotations

import argparse
import subprocess
import unicodedata
from pathlib import Path

TAG = "[stray-glyphs]"

# 按 Unicode 名字的首词分类; 命中即视为可疑.
BAD_SCRIPTS = {
    "HANGUL",
    "HIRAGANA",
    "KATAKANA",
    "CYRILLIC",
    "GREEK",
    "ARABIC",
    "HEBREW",
    "THAI",
    "DEVANAGARI",
    "ARMENIAN",
    "GEORGIAN",
}

SCOPE_SUFFIX = {".md", ".ts", ".tsx", ".js", ".mjs", ".py"}
EXCLUDE_PREFIX = (".agents/", "vendor/", "node_modules/", ".output/", ".wxt/", "dist/")

# 本仓自己的两样豁免: ascii-punct.py 的映射表**必须**含中文标点的字面字符
# (那是它的字典); 下面这份清单要跟着扩, 别把守卫写成只对别人生效的规则.
SELF = "scripts/ascii-punct.py"


def tracked_files(root: Path) -> list[Path]:
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


def scan(path: Path) -> list[tuple[int, str, str]]:
    """返回 [(行号, 字符, Unicode 名)]."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (UnicodeDecodeError, OSError):
        return []
    found: list[tuple[int, str, str]] = []
    for number, line in enumerate(lines, 1):
        for char in line:
            code = ord(char)
            if code < 128:
                continue
            if 0x4E00 <= code <= 0x9FFF:  # 汉字本身不算
                continue
            name = unicodedata.name(char, "")
            script = name.split()[0] if name else ""
            if script in BAD_SCRIPTS:
                found.append((number, char, name))
    return found


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--root", default=".", help="仓库根(默认当前目录)")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    offenders: list[str] = []
    total = 0

    for path in tracked_files(root):
        rel = path.relative_to(root).as_posix()
        if rel == SELF or rel.startswith(EXCLUDE_PREFIX):
            continue
        if path.suffix not in SCOPE_SUFFIX:
            continue
        for line, char, name in scan(path):
            offenders.append(f"{rel}:{line}  {char!r}  {name}")
            total += 1

    if offenders:
        print(f"{TAG} 发现 {total} 个不属于本仓语言体系的字符:")
        for item in offenders[:40]:
            print(f"  {item}")
        if len(offenders) > 40:
            print(f"  ...另有 {len(offenders) - 40} 个")
        print(f"{TAG} 大概是手滑打进去的(混输入法 / 从别处复制), 删掉即可.")
        raise SystemExit(1)

    print(f"{TAG} 干净: 范围内没有可疑文字体系字符.")


if __name__ == "__main__":
    main()
