/**
 * 协议说明:拼在用户每条消息开头,教网页模型排围栏的那段文字.
 *
 * 从 v0.2.0 起,具体的文本被抽离到了 `./prompts/*.md` 文件里,通过 Vite 的 `?raw` 导入.
 * 这里只负责根据上下文(工具目录 / 追踪文件)把段落拼装起来.
 */

import type { ToolInfo } from "./relay";

import headerRaw from "./prompts/header.md?raw";
import fenceBasicsRaw from "./prompts/fence-basics.md?raw";
import catalogNullRaw from "./prompts/catalog-null.md?raw";
import catalogEmptyRaw from "./prompts/catalog-empty.md?raw";
import catalogRaw from "./prompts/catalog.md?raw";
import fileDiffRaw from "./prompts/file-diff.md?raw";
import resultFlowRaw from "./prompts/result-flow.md?raw";

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
 * 后续增强(用户附加说明 / 当前轮次)往这里加字段.
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
    return catalogNullRaw.trimEnd() + "\n";
  }
  if (tools.length === 0) {
    return catalogEmptyRaw.trimEnd() + "\n";
  }
  const lines = tools.map((tool) => `  ${catalogLine(tool)}`);
  return catalogRaw.replace("{{TOOLS}}", lines.join("\n")).trimEnd() + "\n";
}

/**
 * 主说明的一段:`id` 只用于调试与日志,`render` 返回本段的完整文本
 * (含**尾随换行**;最后一段不带).
 */
export type PromptSection = {
  readonly id: string;
  readonly render: (ctx: PromptContext) => string;
};

/**
 * 主说明的分段声明.顺序即拼接顺序;加一段 = 加一项.
 */
export const PROMPT_SECTIONS: readonly PromptSection[] = [
  {
    id: "header",
    render: () => headerRaw.replace("{{HEADER}}", INSTRUCTIONS_HEADER).trimEnd() + "\n\n",
  },
  {
    id: "fence-basics",
    render: () => fenceBasicsRaw.trimEnd() + "\n",
  },
  {
    id: "catalog",
    render: (ctx) => catalogSection(ctx.tools),
  },
  {
    id: "file-diff",
    render: (ctx) => {
      if (ctx.diff === null || ctx.diff === undefined || ctx.diff === "") return "";
      return fileDiffRaw.replace("{{DIFF}}", ctx.diff).trimEnd() + "\n\n";
    },
  },
  {
    id: "result-flow",
    render: () => resultFlowRaw.trimEnd(),
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
