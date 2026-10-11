# dsweb/ -- DeepSeek 网页的逆向笔记

这里放**对 DeepSeek 网页版本身**的逆向结论:它自己的上限怎么算,检查点
在哪,请求体长什么样.跟本仓的实现无关,是"对手侧的事实".

## 边界

- `bundle/` 是**下载下来的站点产物**,不进版本库(跟 `captures/` 同例).
  随时用下面的命令重建.
- `tokenizer.json` 是 DeepSeek-V3 分词器(7.8MB),也不进版本库;取法见下.
- `FINDINGS.md` 是逆向结论,**进版本库**--它是这份材料里唯一有价值的部分.

## 抓取 bundle

```sh
uv run scripts/fetch-dsweb-bundle.py
```

脚本从线上页面**自动发现**当前 bundle 列表(文件名带 hash,发版就变,
写死 URL 会悄悄拿到旧包),默认走本机代理 7897.

**限流时它会自己退避重试;4 次都失败就停**(2026-10-10:经代理与**直连**
都是 HTTP 429,所以换线路没用--限流解除前拿不到新 bundle,别反复重试).
`dsweb/bundle/` 里现有的两份是当时拿到的,够用,除非确认站点发过新版.

## 数 token

网页上限按 **token** 计,前端自己却数不出来(见下"未摸清"),所以要离线数:

```sh
# 一次性取分词器(走代理 7897)
HF_HUB_PROXY=http://127.0.0.1:7897 \
  uv run --with 'huggingface_hub[cli]' hf download \
    deepseek-ai/DeepSeek-V3 tokenizer.json --local-dir dsweb/

# 数任意一段文本(tokenizers 是可选依赖,不进 dsb 的依赖表)
uv run --with tokenizers scripts/count-tokens.py --file 稿子.txt
uv run --with tokenizers scripts/count-tokens.py --file 稿子.txt --repeat 154 --json
```

## 已逆向到的

见 [FINDINGS.md](FINDINGS.md).当前记着的核心事实:

| 项                     | 值                                              | 出处                                   |
| ---------------------- | ----------------------------------------------- | -------------------------------------- |
| 前端文本输入字符上限   | `input_character_limit = 2,621,440`             | `model_configs`(服务端下发,三模型同值) |
| 文件 / 历史 token 限额 | `normal_history_and_file_token_limit = 890,880` | 特性缓存 store                         |
| **本仓上下文预算**     | **900,000 token / 条消息**                      | 工程决策(ADR-0028)                     |
| 服务端实测硬墙         | **982,000 < 上限 < 982,700**(宽 700,±0.07%)     | 真机二分(ADR-0028)                     |
| "超长约 X%"            | `(输入长度 − 2,621,440) / 输入长度 × 100`       | 前端 `vB` 钩子                         |

硬墙那个数是 **DeepSeek-V3 分词器口径**--站点服务端用哪个分词器仍未证实,
但**这已经不是待办**:本仓按 900,000 用,900,880 与 982,700 落在预算的两侧,
两头都还有空间,改预算前再回来查就行.

**仍然没摸清(但已不影响本仓)**:站点服务端用哪个分词器.前端**没有任何
分词器**(`tokenizer`/`BPE`/`count_tokens`/`estimate_token` 全部零命中),
所以前端无法把字符数折算成 token--这也是前端那个 2,621,440 不会与
token 预算对齐的直接原因.服务端那边仍未证实,但预算取值不依赖它.
