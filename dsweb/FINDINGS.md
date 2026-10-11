# FINDINGS -- DeepSeek 网页端逆向结论

抓取:`uv run scripts/fetch-dsweb-bundle.py`(bundle 名带 hash,发版即变,
本文引用的位置以 `main.<hash>.js` 为准,位置号会随发版漂移).

---

## 1. 前端文本输入闸:`input_character_limit = 2,621,440` 字符

**来源**:`cu()` 在服务端的 `model_configs` 里按当前模型取配置,`cf()` 取其
`input_character_limit`:

```js
cf = () => {
  let e = cu();
  if (e) return e.input_character_limit;
};
cu = () => {
  let e = bk();
  return cc().find((t) => t.model_type === e);
};
```

`cc()` 读特性缓存 store 的 `model_configs`,该 store 落在
`localStorage.__ds_remote_feature_store_model`,**服务端下发**.

实测三个模型(快速 / 专家 / 识图)**同值 `2621440`**(= 2.5 × 2²⁰).

### 显示公式与条件

前端 `vB` 钩子(位置 ~605714):

```js
s = cf()                                       // 上限
i = s !== undefined && value.length > s        // 超限?
l = Math.round((value.length - s) / value.length * 100) + "%"   // 百分比
charCounterNode = n && l ? <"超长约 {l}"> : null
```

- **百分比 = (输入长度 − 上限) / 输入长度 × 100**,即"超过上限的部分占
  整条的百分比".
- **只有提交 / 粘贴触发拦截后才显示**:`n` 初值 false,由
  `interceptSubmit`(提交)或 `notifyPasteOverLimit`(粘贴)置真--
  所以"只填不发"时页面**看不到**百分比,这是真机复现不出它的原因.
- 超限时提交被拦(`couldSubmit: !g && !!x && (!v || (y ? !l : C))`,
  位置 ~631519,`y` = `interceptSubmit`),并弹 toast
  "内容超长约 X%,请删减后再试".

用截图与实测全部精确吻合(1570 万字 → 83%,304 万 → 14%,609 万 → 57%,
914 万 → 71%,1218 万 → 78%).

---

## 2. 关键:前端**没有任何分词器**

grep `tokenizer` / `Tokenizer` / `BPE` / `encode_text` / `count_tokens` /
`tokens_count` / `estimate_token` -- **全部零命中**.

**含义**:前端**不具备**把字符数换算成 token 的能力.因此
`input_character_limit = 2,621,440` **不可能**是从任何 token 预算推出来的
--它是一个纯字符数.这也是它与后端 token 上限**天然不对齐**的根因.

---

## 3. 配置里出现 token 的三个数(都不是文本输入闸)

| 键                                    | 值      | 作用域           |
| ------------------------------------- | ------- | ---------------- |
| `file_feature.token_limit`            | 890,880 | 文件上传         |
| `normal_history_and_file_token_limit` | 890,880 | 历史 + 文件      |
| `r1_history_and_file_token_limit`     | 890,880 | R1 的历史 + 文件 |

源码取用(位置 ~397714):

```js
co = ({ thinking, modelType }) => {
  let s = file_feature;
  if (!s) return 61440; // 缺配置时兜底 61440
  return thinking ? s.token_limit_with_thinking : s.token_limit;
};
```

**文本输入那条路上一个 token 字段都没有**--只有字符闸.

---

## 4. 请求体(实测抓包,`/api/v0/chat/completion`)

```json
{
  "chat_session_id": "...",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "<用户正文>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": true,
  "action": null,
  "preempt": false
}
```

- **没有系统提示词字段**--客户端只发用户 `prompt`,系统提示词是**服务端
  加的**(所以客户端侧数不出"系统提示词占多少 token").
- 站点走 **XHR** 收 SSE(`fetch` / `EventSource` 抓不到),这点对写探针很关键.

---

## 5. PoW(工作量证明)

发 completion 前先要过一次 PoW:

```
POST /api/v0/chat/create_pow_challenge
→ { salt, signature, difficulty: 144000, expire_after: 300000,
    target_path: "/api/v0/chat/completion" }
```

`difficulty` 量级不小,且 `expire_after` 只有 5 分钟--探针批量跑时容易撞上
过期失败.

---

## 6. 服务端会回报 token 用量(可用来校准分词器)

```js
nn = (e) =>
  e.status === MessageStatus.CONTEXT_LENGTH_EXCEEDED ? 1 / 0 : e.accumulated_token_usage || 0;
```

- **`status` 是消息完成后的枚举**(`FINISHED` / `WIP` / `INCOMPLETE` /
  `CONTENT_FILTER` / `CONTEXT_LENGTH_EXCEEDED` / `TIMEOUT`).
- **`accumulated_token_usage`**:曾想用它校准分词器,**没成功**.

## 6.2 拒收的真正判据:`finish_reason: "context_length_exceeded"`

**这是目前最硬的判据**,比读页面文字可靠得多(实测抓到,2026-10-09).

超上下文时服务端下发的是**独立的 error 帧**,**不走** `v.response`:

```json
{
  "type": "error",
  "content": "达到对话长度上限,请开启新对话",
  "clear_response": true,
  "finish_reason": "context_length_exceeded"
}
```

- `type` ∈ `warning` / `error`;`clear_response: true` 表示清掉已有的
  部分回复;`finish_reason` 才是判据.
- **注意**:这条路径下 `v.response.status` **压根不下发**--实测一整轮
  21 帧里 `status` 全为空.所以"读 status"和"读 finish_reason"是两条
  不同的路,**拒收走的是后者**.
- 前端协议 schema(位置 ~836455)证实 `finish_reason` 是正式字段:

  ```js
  x1 = { type: "warning" | "error", content, clear_response, finish_reason };
  ```

- **`context_length_exceeded` 在前端 bundle 里 grep 不到**:因为它是
  **服务端下发的协议值**,前端只把它当不透明字符串透传
  (`finish_reason: xY.lqM(xY.mee(...))` = optional string).所以
  "前端枚举里没有它"是对的,但**不能据此以为服务端不用它**--恰恰
  服务端就是用它表达的.

### 校准尝试与失败(2026-10-09)

抓 XHR 流式响应的每一帧(站点走 XHR,`fetch`/`EventSource` 抓不到).
一次 3,436 帧的完整流里:

- **`accumulated_token_usage` 全程为 0**(`nonZeroUsage = 0`).
- 中途曾读到一次 `6,412`,**那是污染样本**--`__frames` 被后一轮覆盖前
  读到的旧数组.**ADR-0028 那轮踩过的"判据自污染"坑又复发了一次**.
- 另一轮(输入 10,112 字,回复"收到")读到 `39`;再用小输入(18 字)
  触发长回复读到 `0`.**39 / 6412 / 0 三个值互不自洽**,与输入,输出长度
  都对不上.

**结论**:这个字段**不能当 token 口径的判据**.真要校准分词器,得换路子
(找一个真返回分词结果的端点,或弄清站点用的是哪个 tokenizer 版本).

### 附:消息帧字段全集(实测)

`v.response` 的字段:

```
message_id, parent_id, model, role, thinking_enabled, ban_edit,
ban_regenerate, status, incomplete_message, accumulated_token_usage,
feedback, inserted_at, search_enabled, fragments, conversation_mode,
has_pending_fragment, auto_continue, search_triggered,
extra_search_providers
```

**没有 `prompt_tokens` / `completion_tokens` 分项**--只有一个合并的
`accumulated_token_usage`.

---

## 6.9 用 `finish_reason` 二分的实测结果(2026-10-09)

判据换成 §6.2 的 `finish_reason`(不看页面文字)后重夹,**独立复现并收窄了
边界**:

| 文本         | 收下          | 拒收          |
| ------------ | ------------- | ------------- |
| 小说 154×    | 977,438 token | --            |
| 小说 155×    | --            | 983,785 token |
| "测"×982,000 | 982,000 token | --            |
| "测"×982,700 | --            | 982,700 token |

**结论:982,000 < 上限 < 982,700 token**(宽 700,约 0.07%).

**收敛的决定性一测**:拿"测"×**983,785**(**故意取非重复数的 token 数**)
去打 → 被拒;而 983,785 正是小说 155× 的 token 数.两种密度完全不同的
文本(0.628 vs 1.000 token/字)在**同一个 token 数**上分界--这就是
"按 token 计"的直接证据,不是拟合出来的.

**本仓按 900,000 记**(`src/lib/continuation.ts` 的
`MAX_SAFE_INPUT_TOKENS`)--**900,000 就是本仓的上下文预算**,与实测
硬墙之间那 ~82,000 token 的差额**是余量**,用来吸收量不到的部分:站点
自己的系统提示词(计入总上下文但不在我们消息里),服务端下发的浮动,
上下文压缩(会让"硬拒"变成"静默截断").详见 ADR-0028.

## 7. 已知 API 端点(逆向用)

```
/api/v0/chat/completion            /api/v0/chat/continue
/api/v0/chat/regenerate            /api/v0/chat/edit_message
/api/v0/chat/resume_stream         /api/v0/chat/stop_stream
/api/v0/chat/history_messages      /api/v0/chat/create_pow_challenge
/api/v0/chat_session/create        /api/v0/chat_session/fetch_page
/api/v0/chat/tts/...
```

超时(特性缓存 `__ds_remote_feature_store`):`completion_request_timeout_ms = 60000`,
`sse_auto_resume_timeout = 3000`.

---

## 8. 未摸清(不要当成已知)

- **站点实际用哪个模型 / 分词器,没验证过.** 本仓 ADR-0028 的"~98 万
  token"是**用 `deepseek-ai/DeepSeek-V3` 分词器**数的,而配置里
  `normal_history_and_file_token_limit = 890,880` 与实测的 ~98 万**对不上**.
  可能原因:站点用的是别的分词器(则 ADR-0028 的数字要按它重算),或
  890,880 另有所指,或上下文预算含了别的开销.**没查清前,ADR-0028 的
  token 口径只在"DeepSeek-V3 分词器"这个前提下成立.**
  校准办法见 §6(用 `accumulated_token_usage` 对账;本轮被 PoW 打断,
  未做完).
- **前端 2,621,440 是按什么拍的**,未知.它显然是"2.5 MB"量级的整数,
  但没有证据说明它对应哪种文本密度或哪次发版决策.
- **891,880 / 890,880 与实测 ~98.2 万的关系**没搞清(见上).两者差 ~9.7%,
  不排除"站点用的 tokenizer 与 DeepSeek-V3 不同"--**这条没证实**.
  下次拿到站点真实 tokenizer 后,第一件事就是用 `finish_reason` 判据重测
  这个差.
- `normal_history_and_file_token_limit` 是否也作用于**纯文本**对话,未验--
  代码里文本那条路没引用它.
- **`accumulated_token_usage` 统计什么**:见 §6.三次读数(39 / 6412 / 0)
  互不自洽,**连它是不是 token 数都没确认**,更谈不上拿它校准分词器.
- **页面上的"达到对话长度上限"↔ `finish_reason: context_length_exceeded`
  的对应关系已验**(见 §6.2,实测同帧同时出现).
- **别的 `finish_reason` 取值有哪些**:只抓到过 `context_length_exceeded`
  一个;`warning` 类(如内容风控)会不会也带 `finish_reason`,值是什么,
  未抓过.
