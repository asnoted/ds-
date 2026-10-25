import { describe, expect, it } from "vitest";

import { INSTRUCTIONS_HEADER, prependInstructions, protocolInstructions } from "./instructions";
import type { ToolInfo } from "./relay";

/** 黄金值:改写一个字这里就红(目录段另有一份带工具的黄金值). */
const TOOLS: readonly ToolInfo[] = [
  { name: "fs_read_file", description: "[fs] 读文件内容", params: ["path", "encoding?"] },
  { name: "shell_run", description: "[sh] 跑一条命令", params: [] },
];

const GOLDEN_NULL = `[ds 协议]需要查本机,跑工具或要第二双眼时,把要调的工具排进围栏块(每块一件工具,语言标记写工具名),然后停止回答,等待回灌:

\`\`\`read
{
  "path": "示例路径"
}
\`\`\`

- 围栏的**语言标记就是工具名**(如 \`read\` / \`write\`),内容是该工具的入参 JSON 对象(没有参数写 \`{}\`).JSON 可以**多行**(带缩进更好读),围栏一直读到独占一行的收尾 \`\`\` 为止;JSON 里别出现独占一行的 \`\`\`.
- 一次回答可以排多个**独立的**围栏块:每个工具调用独占一块,各自用单独一对 \`\`\` 包起来,绝不能把多条调用塞进同一个围栏.多块按顺序执行,结果一起回来;排完就停,不要替它往下写.
- 只读的 \`read\` / \`glob\` / \`grep\` **自动放行**,排进去就执行;\`write\` / \`edit\` 等会改本机状态的工具要等用户在网页上点「执行」,你排完就停手等结果.
- 工具表暂未取到(网关没连上或还没答上来):先别排围栏,等下一条消息再试.
- 结果会自动续着回来(对话里只显示一个短标记,正文不在可见消息里):正文以 \`dsb:\` 开头,第二行是 \`status: ok\`;\`answer\` 是工具结果正文--工具自己报的错也在正文里(如 \`tool-not-running\`:子进程没起),照着往下答.
- \`answer\` 的读法:跟着 \`answer[N]{text}:\`,底下每行一条(缩进两格),第 1 条就是正文第 1 行,依次连起来即完整正文;行首行尾的双引号是包裹,去掉即可,行内偶见的反斜杠只用来包住双引号和反斜杠自己,还原成原字符.换行原样保留,不会被转义.
- 若没有收到 \`dsb:\` 开头的续聊,说明网关没连上:不要追问,不要重排,当作没排过,继续别的内容.`;

const GOLDEN_TOOLS = `[ds 协议]需要查本机,跑工具或要第二双眼时,把要调的工具排进围栏块(每块一件工具,语言标记写工具名),然后停止回答,等待回灌:

\`\`\`read
{
  "path": "示例路径"
}
\`\`\`

- 围栏的**语言标记就是工具名**(如 \`read\` / \`write\`),内容是该工具的入参 JSON 对象(没有参数写 \`{}\`).JSON 可以**多行**(带缩进更好读),围栏一直读到独占一行的收尾 \`\`\` 为止;JSON 里别出现独占一行的 \`\`\`.
- 一次回答可以排多个**独立的**围栏块:每个工具调用独占一块,各自用单独一对 \`\`\` 包起来,绝不能把多条调用塞进同一个围栏.多块按顺序执行,结果一起回来;排完就停,不要替它往下写.
- 只读的 \`read\` / \`glob\` / \`grep\` **自动放行**,排进去就执行;\`write\` / \`edit\` 等会改本机状态的工具要等用户在网页上点「执行」,你排完就停手等结果.
- 可用工具(排目录之外的名字,网关会当场报错):
  - fs_read_file(path, encoding?) -- [fs] 读文件内容
  - shell_run -- [sh] 跑一条命令
- 结果会自动续着回来(对话里只显示一个短标记,正文不在可见消息里):正文以 \`dsb:\` 开头,第二行是 \`status: ok\`;\`answer\` 是工具结果正文--工具自己报的错也在正文里(如 \`tool-not-running\`:子进程没起),照着往下答.
- \`answer\` 的读法:跟着 \`answer[N]{text}:\`,底下每行一条(缩进两格),第 1 条就是正文第 1 行,依次连起来即完整正文;行首行尾的双引号是包裹,去掉即可,行内偶见的反斜杠只用来包住双引号和反斜杠自己,还原成原字符.换行原样保留,不会被转义.
- 若没有收到 \`dsb:\` 开头的续聊,说明网关没连上:不要追问,不要重排,当作没排过,继续别的内容.`;

describe("protocolInstructions", () => {
  it("目录还没取到时逐字一致", () => {
    expect(protocolInstructions({ tools: null })).toBe(GOLDEN_NULL);
  });

  it("取到目录时逐字一致(一行一件工具,格式化好的参数名)", () => {
    expect(protocolInstructions({ tools: TOOLS })).toBe(GOLDEN_TOOLS);
  });

  it("以稳定首行开头,收在网关没连上那句上", () => {
    expect(protocolInstructions({ tools: null }).startsWith(INSTRUCTIONS_HEADER)).toBe(true);
    expect(protocolInstructions({ tools: null }).endsWith("继续别的内容.")).toBe(true);
    expect(protocolInstructions({ tools: null })).toContain("\`\`\`read");
  });

  it("没取到 ≠ 没有:两种说法分开讲", () => {
    expect(protocolInstructions({ tools: null })).toContain("工具表暂未取到");
    expect(protocolInstructions({ tools: [] })).toContain("没有可用工具");
    expect(protocolInstructions({ tools: [] })).not.toContain("工具表暂未取到");
  });
});

describe("prependInstructions", () => {
  it("把协议说明拼在消息开头(用的是同一份目录)", () => {
    const message = prependInstructions("帮我看看这个报错", { tools: TOOLS });
    expect(message.startsWith(`${GOLDEN_TOOLS}\n\n`)).toBe(true);
    expect(message.endsWith("帮我看看这个报错")).toBe(true);
  });

  it("原文一个字不丢", () => {
    const message = prependInstructions("原文", { tools: null });
    expect(message.slice(GOLDEN_NULL.length)).toBe("\n\n原文");
  });
});
