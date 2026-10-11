#!/usr/bin/env python3
"""数一段文本的 token 数与密度(DeepSeek-V3 分词器口径).

**为什么需要它**:网页输入上限是按 **token** 计的,不是按字符(ADR-0028).
但站点**前端没有分词器**(`tokenizer`/`count_tokens` 在 bundle 里零命中),所以
'这个输入是几个 token'这件事,前端答不了,页面也不显示--只能拿 DeepSeek
自己的分词器离线数.这条路是复核 token 口径结论的唯一手段.

**分词器文件不进版本库**(7.8MB).先取一次:

    HF_HUB_PROXY=http://127.0.0.1:7897 \
      uv run --with 'huggingface_hub[cli]' hf download \
        deepseek-ai/DeepSeek-V3 tokenizer.json \
        --local-dir dsweb/

落到 `dsweb/tokenizer.json`(在 .gitignore 里).换模型就换这个文件--
**但换了模型结论就得重算**:站点服务端按哪个分词器算,至今未证实.

**依赖是可选的**:`dsb` 包刻意零依赖(见 pyproject 的 dependencies 注释),
所以这里不 import 任何第三方库进主路径,`tokenizers` 缺了才提示.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_TOKENIZER = "dsweb/tokenizer.json"

# 分词器不在时给的是**可照做的下一步**,不是一句"装依赖".
NO_TOKENIZER = f"""\
找不到分词器.要数 token 得先取一份(一次性,7.8MB,不进版本库):

    HF_HUB_PROXY=http://127.0.0.1:7897 \\
      uv run --with 'huggingface_hub[cli]' hf download \\
        deepseek-ai/DeepSeek-V3 tokenizer.json --local-dir dsweb/

取到的文件默认就在 {DEFAULT_TOKENIZER},本脚本直接认;换路径用 --tokenizer.

还差 tokenizers 本身(可选依赖,不进 dsb 的依赖表):

    uv run --with tokenizers scripts/count-tokens.py ..."""


def load_tokenizer(path: Path):
    """载入分词器.缺文件/缺库分别给不同的下一步."""
    if not path.exists():
        sys.exit(NO_TOKENIZER)
    try:
        from tokenizers import Tokenizer
    except ImportError:
        sys.exit(
            "缺 tokenizers(可选依赖,dsb 主包刻意不引).\n"
            "用 `uv run --with tokenizers scripts/count-tokens.py ...` 跑,"
            "或 `uv add --optional tokenizers` 装进本机环境."
        )
    return Tokenizer.from_file(str(path))


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--tokenizer", default=DEFAULT_TOKENIZER, help=f"分词器路径(默认 {DEFAULT_TOKENIZER})"
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--text", help="直接给正文")
    source.add_argument("--file", help="从文件读正文(大输入走它)")
    source.add_argument("--stdin", action="store_true", help="从标准输入读")
    parser.add_argument("--repeat", type=int, default=1, help="把正文重复这么多次(灌大输入用)")
    parser.add_argument("--json", action="store_true", help="输出 JSON(给别的脚本吃)")
    args = parser.parse_args()

    if args.file:
        body = Path(args.file).read_text(encoding="utf-8")
    elif args.stdin:
        body = sys.stdin.read()
    else:
        body = args.text or ""
    if args.repeat > 1:
        body *= args.repeat
    if not body:
        sys.exit("正文是空的--没有 token 可数.")

    tokenizer = load_tokenizer(Path(args.tokenizer))
    count = len(tokenizer.encode(body).ids)

    if args.json:
        print(
            json.dumps(
                {"chars": len(body), "tokens": count, "tokensPerChar": count / len(body)},
                ensure_ascii=False,
            )
        )
        return

    # 密度是这脚本的产出重点:同一个 token 预算下,密度差多少决定了能塞多少字.
    print(f"字符   {len(body):>12,}")
    print(f"token  {count:>12,}")
    print(f"密度   {count / len(body):>12.3f} token/字")


if __name__ == "__main__":
    main()
