#!/usr/bin/env node
// MCP stdio sidecar exposing pi's five work tools under dsb's names.
// dsb owns the trust boundary (root containment + permission rules); this process only
// resolves paths against DSB_WORK_ROOT and runs the upstream tool implementations.
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { rgPath } from "@vscode/ripgrep";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

process.env.PI_OFFLINE = "1";
process.env.PATH = `${dirname(rgPath)}:${process.env.PATH ?? ""}`;

const ROOT = process.env.DSB_WORK_ROOT || process.cwd();
// Keep the child from outliving dsb's 20s grep deadline; see WORK_GREP_DEADLINE.
const GREP_DEADLINE_MS = 19_000;
const MAX_TEXT = 15_500;
const READ_LIMIT = 200;
const READ_LIMIT_MAX = 2_000;

function atomicWrite(path, content) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const temp = join(dirname(path), `.dsb-write-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // best effort: the original file is untouched either way
    }
    throw error;
  }
}

const read = createReadTool(ROOT);
const write = createWriteTool(ROOT, {
  operations: {
    writeFile: atomicWrite,
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  },
});
const edit = createEditTool(ROOT, {
  operations: {
    readFile: (path) => readFileSync(path),
    writeFile: atomicWrite,
    access: (path) => accessSync(path, constants.R_OK | constants.W_OK),
  },
});
const grep = createGrepTool(ROOT);

function rgFiles(pattern, searchPath, { ignore, limit }) {
  // Later --glob wins, so the exclude patterns must come after the include.
  const args = [
    "--files",
    "--color=never",
    "--hidden",
    "--glob",
    // fd matches a bare name at any depth; mirror that for rg's path-relative globs.
    pattern.includes("/") ? pattern : `**/${pattern}`,
  ];
  for (const glob of ["!**/.git/**", ...ignore.map((item) => `!${item}`)]) {
    args.push("--glob", glob);
  }
  args.push("--", searchPath);
  const run = spawnSync(rgPath, args, { encoding: "utf8", cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(run.stderr.trim() || `ripgrep exited ${run.status}`);
  }
  return (run.stdout || "").split("\n").filter(Boolean).slice(0, limit);
}

const find = createFindTool(ROOT, {
  operations: {
    exists: (path) => existsSync(path),
    glob: rgFiles,
  },
});

function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

async function readWithBudget(args) {
  const base = { path: args.path };
  if (args.offset !== undefined) base.offset = args.offset;
  let limit = args.limit === undefined ? READ_LIMIT : Math.min(args.limit, READ_LIMIT_MAX);
  let result;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      result = await read.execute("read", { ...base, limit });
    } catch (error) {
      // Beyond EOF is an empty page, not a broken tool (dsb's old read behaved the same).
      if (String(error?.message).includes("beyond end of file")) {
        return { content: [{ type: "text", text: `(空:${error.message})` }] };
      }
      throw error;
    }
    if (result?.details?.truncation?.firstLineExceedsLimit) {
      return {
        content: [
          {
            type: "text",
            text: `(第 ${args.offset ?? 1} 行超过 50KB,不整行返回;用 grep 搜片段,或换 offset)`,
          },
        ],
      };
    }
    if (textOf(result).length <= MAX_TEXT || limit <= 1) return result;
    limit = Math.max(1, Math.floor(limit / 2));
  }
  return result;
}

const writeParameters = {
  ...write.parameters,
  properties: {
    ...write.parameters.properties,
    overwrite: {
      type: "boolean",
      description: "文件已存在时是否覆盖;默认 false.",
    },
  },
};

const TOOLS = [
  {
    name: "glob",
    description:
      "按模式找文件,回 相对路径(每行一个). 模式相对工作目录,用 / 分隔,支持 *、?、**;例如 `**/*.ts`.",
    inputSchema: find.parameters,
  },
  {
    name: "read",
    description:
      "读工作目录内一个文本文件的一页. offset 是起始行号(从 1 起),limit 是行数(默认 200). 文件还有更多时,末尾会写明接着读用什么 offset.",
    inputSchema: read.parameters,
  },
  {
    name: "grep",
    description:
      "在工作目录内按正则搜索文本行,回 相对路径:行号: 行. 支持 include/case/literal/context/limit.",
    inputSchema: grep.parameters,
  },
  {
    name: "write",
    description:
      "在工作目录内新建或整文件覆盖(自动建父目录). 已存在时不覆盖;要覆盖请显式传 overwrite=true.",
    inputSchema: writeParameters,
  },
  {
    name: "edit",
    description:
      "按 edits[] 里的 oldText→newText 做精确替换;每段 oldText 必须在原文件里唯一命中, 任一段失败则整个文件不改.",
    inputSchema: edit.parameters,
  },
];

const HANDLERS = {
  glob: (args) => find.execute("glob", args),
  read: (args) => readWithBudget(args),
  grep: (args) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GREP_DEADLINE_MS);
    return grep.execute("grep", args, controller.signal).finally(() => clearTimeout(timer));
  },
  write: (args) => write.execute("write", { path: args.path, content: args.content }),
  edit: (args) => edit.execute("edit", args),
};

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

async function call(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`unknown tool: ${name}`);
  const result = await handler(args ?? {});
  return { content: [{ type: "text", text: textOf(result) }], isError: false };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, "parse error");
    return;
  }
  const { id, method, params } = message;
  if (method === undefined) return;
  if (id === undefined) {
    if (method === "exit") process.exit(0);
    return;
  }
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "dsb-pi-tools", version: "1.0.0" },
      });
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      try {
        reply(id, await call(params?.name, params?.arguments));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        reply(id, { content: [{ type: "text", text }], isError: true });
      }
    } else if (method === "shutdown") {
      reply(id, null);
    } else {
      fail(id, -32601, "method not found");
    }
  } catch (error) {
    fail(id, -32603, error instanceof Error ? error.message : String(error));
  }
});
