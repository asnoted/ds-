/**
 * 协议说明:拼在用户每条消息开头,教网页模型排围栏的那段文字.
 *
 * 文案按 MCP 客户端那条线重写:围栏里装的是一段工具调用 JSON,扩展经本机
 * 网关(dsb 的 `POST /mcp`)转给配好的 MCP servers.工具目录是**动态**的
 * (`tools/list` 汇总自 `mcp.json`,扩展没有输入面,改不了)--所以说明
 * 按目录现拼,防重注只认稳定首行(`INSTRUCTIONS_HEADER`),不再按整段前缀.
 *
 * 改这里必须同步 `instructions.test.ts` 的黄金值.
 *
 * 除了网关目录,还列一段**本地工具**(扩展自带,执行不过网关,见
 * `localtools.ts`)--模型排这些名字时扩展就地执行.
 */

import type { ToolInfo } from "./relay";
import { MAX_CONTINUATION_ROUNDS } from "./rounds";

/** 协议说明的稳定首行:历史消息里带出来的旧说明靠它判重(目录会变,整段前缀会失效). */
export const INSTRUCTIONS_HEADER = "[ds 协议]";

/** 目录里一行:`- name(param, param?) -- 描述`(描述自带 `[server]` 出处). */
function catalogLine(tool: ToolInfo): string {
  const params = tool.params.length > 0 ? `(${tool.params.join(", ")})` : "";
  return `- ${tool.name}${params} -- ${tool.description}`;
}

/** 工具目录那一段:取到就逐行列,没取到的两种说法分开讲(没取到 ≠ 没有). */
function catalogSection(tools: readonly ToolInfo[] | null): string {
  if (tools === null) {
    return "- 工具表暂未取到(网关没连上或还没答上来):先别排围栏,等下一条消息再试.\n";
  }
  if (tools.length === 0) {
    return "- 没有可用工具:网关没配 MCP server(只剩自家的 said_*,不归模型排).\n";
  }
  const lines = tools.map((tool) => `  ${catalogLine(tool)}`);
  return `- 可用工具(排目录之外的名字,网关会当场报错):\n${lines.join("\n")}\n`;
}

/** 协议说明全文(目录为 null = 还没取到). */
export function protocolInstructions(tools: readonly ToolInfo[] | null): string {
  return `${INSTRUCTIONS_HEADER}需要查本机,跑工具或要第二双眼时,把要调的工具排成一个围栏块,然后停止回答,等待回灌:

\`\`\`send
{"tool":"工具名","arguments":{...}}
\`\`\`

- 围栏里是一段 JSON:只有 \`tool\` 与 \`arguments\` 两个键;\`arguments\` 是该工具的入参对象(没有参数写 \`{}\`).
- 一次回答可以排多块(每块一件工具,按顺序执行,结果一起回来);排完就停,不要替它往下写.
${catalogSection(tools)}- 另有扩展自带的本地工具(不占网关目录,排了就地执行):
  - send.page(question) -- 往页面发一条问题,发完即回确认.页面的回答照旧进对话,不在确认里给你.
- 本地工具被闸挡下 / 超时 / 页面不在时不回灌:与"网关没连上"同一处置,当作没排过,别重排.
- 本地工具回了失败码时读正文里 \`error\` 那一行,别猜也别原样重排:闸或退避类(\`disabled\` / \`backing-off\`)是人在管,等用户开口再说;页面认不出那件事(\`page-changed\` / \`unknown-action\`)换个问法或晚一轮再排.
- 结果会自动续着回来(对话里只显示一个短标记,正文不在可见消息里):正文以 \`agent:\` 开头,第二行是 \`status: ok\`;\`answer\` 是工具结果正文--工具自己报的错也在正文里(如 \`tool-not-running\`:子进程没起),照着往下答.
- \`answer\` 的读法:跟着 \`answer[N]{text}:\`,底下每行一条(缩进两格),第 1 条就是正文第 1 行,依次连起来即完整正文;行首行尾的双引号是包裹,去掉即可,行内偶见的反斜杠只用来包住双引号和反斜杠自己,还原成原字符.换行原样保留,不会被转义.
- \`read\` 的正文是**逐行带行号**的(\`12: 内容\`),末尾有一句脚注写明读到哪,接着读用什么 \`offset\`(如"接着读:offset=201").文件长就**按那个 offset 翻页**,别改 offset 重读开头,也别拿半页当全貌;脚注说"文件读完"才是读完.行号是呈现层的前缀,正文内容一字不改.
- 自动续聊最多 ${MAX_CONTINUATION_ROUNDS} 轮:到顶会停手,那时等用户开口再继续(不要把同一块围栏重复排一遍).
- 若没有收到 \`agent:\` 开头的续聊,说明网关没连上:不要追问,不要重排,当作没排过,继续别的内容.
- 需要人拍板(选哪个,答什么)时,把问题排成另一种围栏块,然后停止回答,等人的回答:

\`\`\`ask
<question>
\`\`\`

- 规则同上:多行以单独一行 \`\`\` 结束,一次最多一块,排完就停.
- 人的回答会作为普通消息进来,收到后继续回答;不要追问,不要重排.
- 用不到工具时忽略本说明.`;
}

/** 把协议说明拼到一条用户消息的开头(注入通过改写用户消息实现). */
export function prependInstructions(message: string, tools: readonly ToolInfo[] | null): string {
  return `${protocolInstructions(tools)}\n\n${message}`;
}
