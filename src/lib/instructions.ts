/**
 * 协议说明:拼在用户每条消息开头,教网页模型排围栏的那段文字.
 *
 * 文案按 MCP 客户端那条线重写:围栏里装的是一段工具调用 JSON,扩展经本机
 * 网关(dsb 的 `POST /mcp`)转给配好的 MCP servers.工具目录是**动态**的
 * (`tools/list` 汇总自 `mcp.json`,扩展没有输入面,改不了)--所以说明
 * 按目录现拼,防重注只认稳定首行(`INSTRUCTIONS_HEADER`),不再按整段前缀.
 *
 * **结构**:主说明由 `PROMPT_SECTIONS` 分段声明,每段一个 `render`;
 * `protocolInstructions` 逐段渲染后拼接.加一段 = `PROMPT_SECTIONS` 里
 * 加一项,不动模板拼接逻辑.每段**自带尾随换行**(最后一段除外),拼接用
 * 空串--与旧版单个 template string 的输出逐字一致.
 *
 * 说明**只教工具目录与回灌怎么读**:本地工具(send.page)、ask 围栏、
 * read 翻页这些段已按"只留工具说明"收窄,不再拼进主说明.
 *
 * 改这里必须同步 `instructions.test.ts` 的黄金值.
 */

import type { ToolInfo } from "./relay";

/** 协议说明的稳定首行:历史消息里带出来的旧说明靠它判重(目录会变,整段前缀会失效). */
export const INSTRUCTIONS_HEADER = "[ds 协议]";

/**
 * `read` 脚注三态的字面量:dsb `work.py` 产出那半,这里存同一份教模型认
 * (两半各自对着线协议 `protocol/fixtures/read.json` 断言,旧 0010).
 */
export const READ_FOOTNOTE_TEMPLATES = {
  /** 文件读完:不编下一步. */
  done: "(文件读完:共 {total} 行)",
  /** 页按行数到头,文件还有:给接着读的 offset. */
  more: "(第 {start}-{end} 行 / 共 {total} 行,接着读:offset={end + 1})",
  /** 页被单次字节预算砍在半路:先说被砍,再给 offset. */
  capped: "(字节预算截断,第 {start}-{end} 行 / 共 {total} 行,接着读:offset={end + 1})",
} as const;

/** `read` 单页行数:教模型的"接着读"例子按它算(接着读的 offset = 单页行数 + 1). */
export const READ_PAGE_LINES = 200;

/**
 * 渲染协议说明时的上下文.现在只有工具目录(网关 `tools/list` 汇总),
 * 后续增强(用户附加说明 / 当前轮次)往这里加字段,`PROMPT_SECTIONS`
 * 的 `render` 按需取用--调用方不必知道说明分几段.
 */
export type PromptContext = {
  /** 网关汇总的工具目录;null = 还没取到. */
  readonly tools: readonly ToolInfo[] | null;
  /** 追踪文件自上次注入以来的 diff;null = 无变更. */
  readonly diff?: string | null;
};

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

/**
 * 主说明的一段:`id` 只用于调试与日志,`render` 返回本段的完整文本
 *(含**尾随换行**;最后一段不带).
 */
export type PromptSection = {
  readonly id: string;
  readonly render: (ctx: PromptContext) => string;
};

/**
 * 主说明的分段声明.顺序即拼接顺序;加一段 = 加一项.
 *
 * 每段**自带尾随换行**(最后一段除外),所以 `protocolInstructions` 用空串
 * 拼接,不额外插换行--与旧版单个 template string 的输出逐字一致.
 */
export const PROMPT_SECTIONS: readonly PromptSection[] = [
  {
    id: "header",
    render: () =>
    `${INSTRUCTIONS_HEADER}需要查本机,跑工具或要第二双眼时,把要调的工具排进围栏块(每块一件工具),然后停止回答,等待回灌:\n` +      "\n" +
      "```send\n" +
      '{"tool":"工具名","arguments":{...}}\n' +
      "```\n" +
      "\n",
  },
  {
    id: "fence-basics",
    render: () =>
      "- 围栏里是一段 JSON:只有 `tool` 与 `arguments` 两个键;`arguments` 是该工具的入参对象(没有参数写 `{}`).\n" +
      "- 一次回答可以排多个**独立的**围栏块:每个工具调用独占一块,各自用单独一对 ``` 包起来,绝不能把多条 JSON 塞进同一个围栏.多块按顺序执行,结果一起回来;排完就停,不要替它往下写.\n",  },
  {
    id: "catalog",
    render: (ctx) => catalogSection(ctx.tools),
  },
  {
    id: "file-diff",
    render: (ctx) => {
      if (ctx.diff === null || ctx.diff === undefined || ctx.diff === "") return "";
      return `- 你追踪的文件自上次对话以来有变更,以下是 diff(需要重读时用 read 工具):\n${ctx.diff}\n\n`;
    },
  },
  {
    id: "result-flow",
    render: () =>
      "- 结果会自动续着回来(对话里只显示一个短标记,正文不在可见消息里):正文以 `agent:` 开头,第二行是 `status: ok`;`answer` 是工具结果正文--工具自己报的错也在正文里(如 `tool-not-running`:子进程没起),照着往下答.\n" +
      "- `answer` 的读法:跟着 `answer[N]{text}:`,底下每行一条(缩进两格),第 1 条就是正文第 1 行,依次连起来即完整正文;行首行尾的双引号是包裹,去掉即可,行内偶见的反斜杠只用来包住双引号和反斜杠自己,还原成原字符.换行原样保留,不会被转义.\n" +
      "- 若没有收到 `agent:` 开头的续聊,说明网关没连上:不要追问,不要重排,当作没排过,继续别的内容.",
  },
];

/** 协议说明全文.目录为 null = 还没取到. */
export function protocolInstructions(ctx: PromptContext): string {
  return PROMPT_SECTIONS.map((section) => section.render(ctx)).join("");
}

/** 把协议说明拼到一条用户消息的开头(注入通过改写用户消息实现). */
export function prependInstructions(message: string, ctx: PromptContext): string {
  return `${protocolInstructions(ctx)}\n\n${message}`;
}
