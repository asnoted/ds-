"""把 archify 渲染出的独立 HTML 抽成 README 可内嵌的 SVG.

archify 的 viewer 里有个'导出 dual-theme SVG'功能(Download → SVG),它
知道哪些 CSS 规则该进 SVG,变量该解析成什么值.这段逻辑写在生成的 HTML 的
内联 `<script>` 里(Export -- Share Card / PNG / JPEG / WebP / SVG / WebM 那段
注释下面),闭包内,外部调不到,所以这里按同样的口径离线复刻:

1. **只留 SVG 作用域的规则**:选择器以 `svg` / `:root` / `[data-theme` /
   `[data-preset` / `.c-` / `.t-` / `.a-` / `.m-` 开头的 plain style rule,
   外加 `archify-` 前缀命名的 @keyframes.`html ... .diagram-container > svg ...`
   这种带 HTML 祖先的规则**不进** SVG--独立 SVG 里没有 `<html>`,它们本来
   就不匹配.字体块不重取:SVG 体内已经自带 `<style id="archify-fonts">`.
2. **变量解析成具体值**:按 viewer 探针的做法,对
   `<html data-preset="classic" data-theme="light">` 的匹配顺序叠加各变量块
   (`:root` 默认 → `[data-preset="classic"]` → `[data-theme]` →
   `[data-preset][data-theme]`),后写的赢.**只收这条链上的块**,像
   `[data-preset="editorial"]` 那套预设变量就不会混进来.
3. 输出结构照 viewer 的 `autoTheme` 分支:`:root, svg { vars }` +
   `@media (prefers-color-scheme: dark)` 换暗色变量.

用法:python3 scripts/extract-diagram-svg.py <in.html> <out.svg> [light|dark]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# viewer 的选择器过滤器(Export 段里的字面量)
SVG_SCOPE = re.compile(r"(^|,)\s*(svg|:root|\[data-theme|\[data-preset|\.c-|\.t-|\.a-|\.m-)")

FONT_STACK = (
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, "
    "'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono CJK SC', "
    "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', monospace"
)

# 变量块的选择器 → 该块对 <html data-preset="classic" data-theme="X"> 是否匹配
PRESET = "classic"


def load_styles(html: str) -> str:
    """取出 HTML 里所有 `<style>` 的内容(正文外的 <style> 块)."""
    chunks = []
    for m in re.finditer(r"<style[^>]*>", html):
        end = html.find("</style>", m.end())
        if end == -1:
            continue
        chunks.append(html[m.end() : end])
    return "\n".join(chunks)


def parse_rules(css: str) -> list[tuple[str, str]]:
    """顶层规则 → [(selector, body)];注释在选择器位置的原样留着."""
    rules: list[tuple[str, str]] = []
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j == -1:
            break
        selector = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
            k += 1
        if selector:
            rules.append((selector, css[j + 1 : k - 1]))
        i = k
    return rules


def selector_matches(selector: str, theme: str) -> bool:
    """这条变量块的选择器会不会命中 <html data-preset=classic data-theme=theme>.

    只认四类:`html`/`:root`(无预设限定),`[data-preset=classic]`,
    `[data-theme=<theme>]`,`[data-preset=classic][data-theme=<theme>]`.
    出现别的预设名(editorial / signal-flow / blueprint ...)直接否.
    """
    s = " ".join(selector.split())
    if not s:
        return False
    presets = set(re.findall(r'\[data-preset="?([^"\]]+)"?\]', s))
    if presets - {PRESET}:
        return False
    themes = set(re.findall(r'\[data-theme="?([^"\]]+)"?\]', s))
    return not themes - {theme}


def resolve_vars(rules: list[tuple[str, str]], theme: str) -> str:
    """按文档顺序叠加命中的变量块,后写的赢."""
    values: dict[str, str] = {}
    for selector, body in rules:
        if "--" not in body:
            continue
        if not selector_matches(selector, theme):
            continue
        for name, value in re.findall(r"(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+)", body):
            values[name] = value.strip()
    return " ".join(f"{name}: {value};" for name, value in values.items())


def svg_scope(selector: str) -> bool:
    """选择器是否属于 SVG 作用域.

    选择器前面常挂着 `/* 分节注释 */`,会挡住 `(^|,)` 锚点,先剥掉注释再判.
    """
    cleaned = re.sub(r"/\*.*?\*/", " ", selector, flags=re.S)
    return bool(SVG_SCOPE.search(cleaned))


def build_svg(html: str, theme: str) -> str:
    # SVG 本体:正文里第一个 `<svg ...>...</svg>`.开标签缺 xmlns,补上.
    svg_start = html.find("<svg")
    if svg_start == -1:
        raise SystemExit("HTML 里找不到 <svg>")
    svg_end = html.find("</svg>", svg_start) + len("</svg>")
    body = html[svg_start:svg_end]
    open_tag_end = body.find(">") + 1
    open_tag, inner = body[:open_tag_end], body[open_tag_end:]
    if "xmlns=" not in open_tag:
        open_tag = open_tag.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ', 1)

    rules = parse_rules(load_styles(html))

    # 只留 SVG 作用域的 plain style rule + archify- 前缀的 @keyframes
    kept: list[str] = []
    for selector, rule_body in rules:
        bare = re.sub(r"/\*.*?\*/", " ", selector, flags=re.S).strip()
        if bare.startswith("@font-face"):
            continue  # 字体由 SVG 体内自带的 archify-fonts 块负责
        if bare.startswith("@keyframes"):
            if re.match(r"@keyframes\s+archify-", bare):
                kept.append(f"{bare} {{{rule_body}}}")
            continue
        if bare.startswith("@"):
            continue  # @media 面向 Viewer 窗口,不进独立文件
        if not svg_scope(bare):
            continue
        if re.search(r"--[a-zA-Z0-9-]+\s*:", rule_body):
            continue  # 变量定义块:已解析成具体值放进 :root, svg {...}
        # 预设限定的规则只留 classic(本 SVG 根的 data-preset):别的预设
        # 既不会命中,白占体积,带 animation/filter 的还可能污染渲染.
        presets = set(re.findall(r'\[data-preset="?([^"\]]+)"?\]', bare))
        if presets - {PRESET}:
            continue
        kept.append(f"{bare} {{{rule_body}}}")

    light = resolve_vars(rules, "light")
    dark = resolve_vars(rules, "dark")

    pinned = light if theme == "light" else dark
    style = (
        f"svg {{ font-family: {FONT_STACK}; }}\n"
        + "\n".join(kept)
        + "\n:root, svg { "
        + dark
        + " }\n"
        + "@media (prefers-color-scheme: light) { :root, svg { "
        + light
        + " } }\n"
        + f'svg[data-theme="{theme}"] {{ '
        + pinned
        + " }\n"
        + "rect.c-bg-rect { fill: var(--bg); }\n"
    )

    # 背景 rect:viewer 用 c-bg-rect 让背景跟着变量走
    viewbox = re.search(r'viewBox="([^"]+)"', open_tag)
    bg = ""
    if viewbox:
        vb = viewbox.group(1).split()
        bg = f'<rect class="c-bg-rect" x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}"/>'

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + open_tag
        + "\n<style>\n"
        + style
        + "</style>\n"
        + bg
        + inner
        + "\n"
    )


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__ or "usage: extract-diagram-svg.py in.html out.svg [theme]")
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    theme = sys.argv[3] if len(sys.argv) > 3 else "light"
    svg = build_svg(src.read_text(encoding="utf-8"), theme)
    dst.write_text(svg, encoding="utf-8")
    print(f"{dst}: {len(svg)} 字节, theme={theme}")


if __name__ == "__main__":
    main()
