import { describe, expect, it } from "vitest";

import { INSTRUCTIONS_HEADER, prependInstructions, protocolInstructions } from "./instructions";
import { LOCAL_TOOLS } from "./localtools";
import type { ToolInfo } from "./relay";

/** 黄金值:改写一个字这里就红(目录段另有一份带工具的黄金值). */
const TOOLS: readonly ToolInfo[] = [
  { name: "fs_read_file", description: "[fs] 读文件内容", params: ["path", "encoding?"] },
  { name: "shell_run", description: "[sh] 跑一条命令", params: [] },
];

const GOLDEN_NULL = `[ds 协议]需要查本机,跑工具或要第二双眼时,把要调的工具排成一个围栏块,然后停止回答,等待回灌:

\`\`\`send
{"tool": "工具名", "arguments": {...}}
\`\`\`

- 围栏里是一段 JSON:只有 \`tool\` 与 \`arguments\` 两个键;\`arguments\` 是该工具的入参对象(没有参数写 \`{}\`).
- 一次回答可以排多块(每块一件工具,按顺序执行,结果一起回来);排完就停,不要替它往下写.
- 工具表暂未取到(网关没连上或还没答上来):先别排围栏,等下一条消息再试.
- 另有扩展自带的本地工具(不占网关目录,排了就地执行):
  - send.page(question) -- 往页面发一条问题,发完即回确认.页面的回答照旧进对话,不在确认里给你.
- 本地工具被闸挡下 / 超时 / 页面不在时不回灌:与"网关没连上"同一处置,当作没排过,别重排.
- 本地工具回了失败码时读正文里 \`error\` 那一行,别猜也别原样重排:闸或退避类(\`disabled\` / \`backing-off\`)是人在管,等用户开口再说;页面认不出那件事(\`page-changed\` / \`unknown-action\`)换个问法或晚一轮再排.
- 结果会自动续着回来(对话里只显示一个短标记,正文不在可见消息里):正文以 \`agent:\` 开头,第二行是 \`status: ok\`;\`answer\` 是工具结果正文--工具自己报的错也在正文里(如 \`tool-not-running\`:子进程没起),照着往下答.
- \`answer\` 的读法:跟着 \`answer[N]{text}:\`,底下每行一条(缩进两格),第 1 条就是正文第 1 行,依次连起来即完整正文;行首行尾的双引号是包裹,去掉即可,行内偶见的反斜杠只用来包住双引号和反斜杠自己,还原成原字符.换行原样保留,不会被转义.
- 自动续聊最多 8 轮:到顶会停手,那时等用户开口再继续(不要把同一块围栏重复排一遍).
- 若没有收到 \`agent:\` 开头的续聊,说明网关没连上:不要追问,不要重排,当作没排过,继续别的内容.
- 需要人拍板(选哪个,答什么)时,把问题排成另一种围栏块,然后停止回答,等人的回答:

\`\`\`ask
<question>
\`\`\`

- 规则同上:多行以单独一行 \`\`\` 结束,一次最多一块,排完就停.
- 人的回答会作为普通消息进来,收到后继续回答;不要追问,不要重排.
- 用不到工具时忽略本说明.`;

const GOLDEN_TOOLS = `[ds 协议]需要查本机,跑工具或要第二双眼时,把要调的工具排成一个围栏块,然后停止回答,等待回灌:

\`\`\`send
{"tool": "工具名", "arguments": {...}}
\`\`\`

- 围栏里是一段 JSON:只有 \`tool\` 与 \`arguments\` 两个键;\`arguments\` 是该工具的入参对象(没有参数写 \`{}\`).
- 一次回答可以排多块(每块一件工具,按顺序执行,结果一起回来);排完就停,不要替它往下写.
- 可用工具(排目录之外的名字,网关会当场报错):
  - fs_read_file(path, encoding?) -- [fs] 读文件内容
  - shell_run -- [sh] 跑一条命令
- 另有扩展自带的本地工具(不占网关目录,排了就地执行):
  - send.page(question) -- 往页面发一条问题,发完即回确认.页面的回答照旧进对话,不在确认里给你.
- 本地工具被闸挡下 / 超时 / 页面不在时不回灌:与"网关没连上"同一处置,当作没排过,别重排.
- 本地工具回了失败码时读正文里 \`error\` 那一行,别猜也别原样重排:闸或退避类(\`disabled\` / \`backing-off\`)是人在管,等用户开口再说;页面认不出那件事(\`page-changed\` / \`unknown-action\`)换个问法或晚一轮再排.
- 结果会自动续着回来(对话里只显示一个短标记,正文不在可见消息里):正文以 \`agent:\` 开头,第二行是 \`status: ok\`;\`answer\` 是工具结果正文--工具自己报的错也在正文里(如 \`tool-not-running\`:子进程没起),照着往下答.
- \`answer\` 的读法:跟着 \`answer[N]{text}:\`,底下每行一条(缩进两格),第 1 条就是正文第 1 行,依次连起来即完整正文;行首行尾的双引号是包裹,去掉即可,行内偶见的反斜杠只用来包住双引号和反斜杠自己,还原成原字符.换行原样保留,不会被转义.
- 自动续聊最多 8 轮:到顶会停手,那时等用户开口再继续(不要把同一块围栏重复排一遍).
- 若没有收到 \`agent:\` 开头的续聊,说明网关没连上:不要追问,不要重排,当作没排过,继续别的内容.
- 需要人拍板(选哪个,答什么)时,把问题排成另一种围栏块,然后停止回答,等人的回答:

\`\`\`ask
<question>
\`\`\`

- 规则同上:多行以单独一行 \`\`\` 结束,一次最多一块,排完就停.
- 人的回答会作为普通消息进来,收到后继续回答;不要追问,不要重排.
- 用不到工具时忽略本说明.`;

describe("protocolInstructions", () => {
  it("目录还没取到时逐字一致", () => {
    expect(protocolInstructions(null)).toBe(GOLDEN_NULL);
  });

  it("取到目录时逐字一致(一行一件工具,格式化好的参数名)", () => {
    expect(protocolInstructions(TOOLS)).toBe(GOLDEN_TOOLS);
  });

  it("以稳定首行开头,收在忽略说明上", () => {
    expect(protocolInstructions(null).startsWith(INSTRUCTIONS_HEADER)).toBe(true);
    expect(protocolInstructions(null).endsWith("用不到工具时忽略本说明.")).toBe(true);
    expect(protocolInstructions(null)).toContain("```send");
    expect(protocolInstructions(null)).toContain("```ask");
  });

  it("没取到 ≠ 没有:两种说法分开讲", () => {
    expect(protocolInstructions(null)).toContain("工具表暂未取到");
    expect(protocolInstructions([])).toContain("没有可用工具");
    expect(protocolInstructions([])).not.toContain("工具表暂未取到");
  });

  it("本地工具段与名册一致:每件本地工具的名字 / 参数 / 说明都在(防两处漂移)", () => {
    const text = protocolInstructions(null);
    for (const tool of LOCAL_TOOLS) {
      const params = tool.params.length > 0 ? `(${tool.params.join(", ")})` : "";
      expect(text).toContain(`  - ${tool.name}${params} -- ${tool.description}`);
    }
  });
});

describe("prependInstructions", () => {
  it("把协议说明拼在消息开头(用的是同一份目录)", () => {
    const message = prependInstructions("帮我看看这个报错", TOOLS);
    expect(message.startsWith(`${GOLDEN_TOOLS}\n\n`)).toBe(true);
    expect(message.endsWith("帮我看看这个报错")).toBe(true);
  });

  it("原文一个字不丢", () => {
    const message = prependInstructions("原文", null);
    expect(message.slice(GOLDEN_NULL.length)).toBe("\n\n原文");
  });
});
