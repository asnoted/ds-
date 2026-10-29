/**
 * `deepseek-web` model route.
 *
 * DSH's loop sends the full session log every step; a web completion takes
 * `(sessionId, prompt)` and keeps the history server-side. The adapter maps one
 * DSH session onto one web session through {@link createSessionMap}: the first
 * (or a rebuilt) turn sends a transcript, later turns send only the delta.
 *
 * One web turn runs at a time: the channel is a single browser session with a
 * long round trip, so a second request queues (and cancellation leaves the
 * queue) instead of opening a parallel turn.
 *
 * Text only. Tool schemas ride in the transcript as a catalog, and the model
 * calls them with fenced blocks that {@link parseAnswer} turns back into
 * tool-call blocks.
 *
 * @module dsh-dsb/web-model
 */

import { createHash } from 'node:crypto';

import { createPacer } from './pace.js';
import { createSessionMap } from './session-map.js';
import { createSession, fetchMessages, streamCompletion } from './deepseek.js';
import { readVault } from './vault.js';

export const PROVIDER = 'deepseek-web';
export const MODEL = 'deepseek-web';
const CONTEXT_WINDOW = 128_000;
/** Bump when the catalog or tool protocol changes; bound chats then rebuild. */
const PROMPT_VERSION = 5;

const LABEL = { system: 'SYSTEM', user: 'USER', assistant: 'ASSISTANT', tool: 'TOOL' };

function abortError() {
  return Object.assign(new Error('已停止生成'), { code: 'ABORTED' });
}

/** One in-flight turn; waiters are FIFO and drop out on their own signal. */
function createLock() {
  let active = false;
  const queue = [];

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve(makeRelease());
      } else {
        active = false;
      }
    };
  };

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (!active) {
        active = true;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: null };
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index !== -1) queue.splice(index, 1);
          reject(abortError());
        };
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        queue.push(waiter);
      });
    },
  };
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') return block.text;
  if (block.type === 'tool-call') return `[tool call ${block.name || ''}] ${block.arguments || ''}`;
  if (block.type === 'tool-result') {
    const value = block.content;
    return `[tool result] ${typeof value === 'string' ? value : JSON.stringify(value ?? '')}`;
  }
  if (block.type === 'image') return '[image]';
  if (block.type === 'file') return '[file]';
  return '';
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.map(blockText).filter(Boolean).join('\n');
}

function toolProtocol() {
  return [
    'You can call tools with a fenced block tagged `tool`. A call looks like:',
    '```tool',
    '{TOOLNAME: PARAMETERS}',
    '```',
    'The key is a tool name from TOOL CATALOG and the value is that call\'s argument text, not JSON. One call per block; emit several blocks for several calls. Text outside the blocks is shown to the user.',
  ].join('\n');
}

/** The tool schema's type is the authority; the model sometimes stringifies numbers and booleans. */
function coerceArg(value, schema) {
  const type = schema && typeof schema === 'object' ? schema.type : undefined;
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'string' || value.trim() === '') return value;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if ((type === 'array' || type === 'object') && typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

/**
 * The fence body is the argument text itself, not JSON: the command for a
 * shell tool, the program for run_code. A single-parameter tool takes the whole
 * body; otherwise it goes to the first required string parameter.
 */
function fenceArgs(body, tool) {
  const parameters = tool && tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : {};
  const properties = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  const names = Object.keys(properties);
  if (names.length === 0) return {};
  const isString = (name) => properties[name] && properties[name].type === 'string';
  const target = names.length === 1
    ? names[0]
    : required.find(isString) || names.find(isString) || names[0];
  const args = { [target]: coerceArg(body.trim(), properties[target]) };
  // run_code requires a non-empty UI label; the argument's first line is the
  // only summary the model actually wrote.
  if (target !== 'description' && required.includes('description') && properties.description) {
    args.description = body.trim().split('\n')[0].slice(0, 80);
  }
  return args;
}

/** Every tool the host exposes with a usable name; a nameless entry cannot be called. */
function namedTools(tools) {
  return (Array.isArray(tools) ? tools : []).filter((tool) => tool && typeof tool.name === 'string' && tool.name);
}

function toolCatalog(tools) {
  const list = namedTools(tools);
  const lines = [];
  for (const tool of list) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
    const description = typeof tool.description === 'string'
      ? tool.description.replace(/\s+/g, ' ').slice(0, 300)
      : '';
    lines.push(`- ${tool.name}: ${description}`);
    if (tool.parameters && typeof tool.parameters === 'object') {
      lines.push(`  parameters: ${JSON.stringify(tool.parameters)}`);
    }
  }
  return lines.length === 0 ? '' : `${toolProtocol()}\n\nTOOL CATALOG\n${lines.join('\n')}`;
}

/** The host's current tool declarations decide when a bound web chat is stale. */
function protocolFor(tools) {
  const schemas = namedTools(tools).map((tool) => [tool.name, tool.description, tool.parameters]);
  return `${PROMPT_VERSION}:${createHash('sha256').update(JSON.stringify(schemas)).digest('hex').slice(0, 16)}`;
}

/** A model that loses the thread can repeat a call forever; 9 bounds one answer's damage. */
const MAX_TOOL_CALLS = 9;

/**
 * Split a buffered answer into text and tool calls.
 *
 * Only `tool` fences holding `{name: arguments}` are calls: the prompt teaches
 * exactly that shape. Anything else — the web app's own/memory calls, a
 * markdown code sample, an unknown name — stays visible text.
 */
function parseAnswer(answer, tools) {
  const byName = new Map(namedTools(tools).map((tool) => [tool.name, tool]));
  if (byName.size === 0) return [{ type: 'text', text: answer }];
  const blocks = [];
  const state = { calls: 0, truncated: false };
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = fence.exec(answer)) !== null) {
    const payload = [match[1].trim().replace(/^tool\b/, ''), match[2].trim()].filter(Boolean).join('\n').trim();
    const call = /^\{\s*([^{}\s:]+)\s*:\s*([\s\S]*?)\s*\}$/.exec(payload);
    const tool = call && byName.get(call[1]);
    const args = tool && call[2].trim() ? fenceArgs(call[2], tool) : undefined;
    if (!args) continue;
    const before = answer.slice(last, match.index);
    if (before) blocks.push({ type: 'text', text: before });
    if (state.calls >= MAX_TOOL_CALLS) {
      state.truncated = true;
      blocks.push({ type: 'text', text: match[0] });
    } else {
      state.calls += 1;
      blocks.push({ type: 'tool-call', name: call[1], arguments: JSON.stringify(args) });
    }
    last = fence.lastIndex;
  }
  const tail = answer.slice(last);
  if (tail) blocks.push({ type: 'text', text: tail });
  if (state.truncated) {
    blocks.push({ type: 'text', text: '（本轮工具调用超过 ' + MAX_TOOL_CALLS + ' 个，其余未执行）' });
  }
  return blocks;
}
/**
 * A fresh web session has no history, so the whole log goes in one transcript.
 * An ordinary step is one new user message; send it as it was typed.
 *
 * The web session generated the assistant turns itself, so a delta never
 * re-sends them — only the system, user, and tool messages that are new.
 * The tool catalog rides along with the rebuild; later turns already have it.
 */
function promptFor(fresh, rebuild, tools, system) {
  const send = rebuild ? fresh : fresh.filter((message) => message.role !== 'assistant');
  const transcript = rebuild || send.length !== 1 || send[0].role !== 'user';
  const parts = [];
  if (typeof system === 'string' && system.trim()) parts.push(`SYSTEM:\n${system.trim()}`);
  const catalog = rebuild ? toolCatalog(tools) : '';
  if (catalog) parts.push(catalog);
  let asked = 0;
  for (const message of send) {
    const text = messageText(message).trim();
    if (!text) continue;
    if (message.role === 'user' || message.role === 'tool') asked += 1;
    parts.push(transcript ? `${LABEL[message.role] || message.role}:\n${text}` : text);
  }
  if (asked === 0) return '';
  return parts.join('\n\n');
}

export function createWebModelAdapter({
  map = createSessionMap(),
  token = () => readVault().token,
  create = createSession,
  complete = streamCompletion,
  history = fetchMessages,
  lock = createLock(),
  pace = createPacer(),
} = {}) {
  return {
    providerInfo(provider) {
      return { id: provider, name: 'DeepSeek Web' };
    },

    providerRetryPolicy() {
      return undefined;
    },

    async listModels(provider) {
      // The host rejects catalog entries whose `provider` is not the route.
      return [{ provider, id: MODEL, name: 'DeepSeek Web', contextWindow: CONTEXT_WINDOW }];
    },

    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: 'DeepSeek Web',
        context: { contextWindow: CONTEXT_WINDOW },
        inputModalities: ['text'],
      };
    },

    async prepareCall(provider, model) {
      return {
        model: await this.resolveModel(provider, model),
        stream: (options) => this.stream(options),
      };
    },

    async *stream(options) {
      const credential = token();
      if (!credential) throw new Error('DeepSeek 网页登录态不存在，请先在聊天面板连接账号');
      const key = typeof options.sessionId === 'string' ? options.sessionId : '';
      const messages = Array.isArray(options.messages) ? options.messages : [];
      // Title/compaction calls carry the session id too, but they are not the
      // conversation: only the agent loop sends `toolHistory`. Mapping those
      // auxiliary calls would rebind the session to a title-only web chat.
      const isTurn = Boolean(key) && options.toolHistory !== undefined;

      const release = await lock.acquire(options.signal);
      let fresh = false;
      let produced = false;
      try {
        const protocol = protocolFor(options.tools);
        const pending = isTurn
          ? map.pending(key, messages, protocol)
          : { fresh: messages, rebuild: true };
        let webSessionId = isTurn ? map.webSessionFor(key) : '';
        // The web app is a second writer: a user can append to (or edit) the
        // same chat on chat.deepseek.com between steps. The map only tracks the
        // DSH prefix, so without this check the next delta would hang off a web
        // branch DSH never saw. The web is the authority here: re-point the
        // branch tip at the web tip so the next completion continues from the
        // real web history instead of forking a fresh session.
        // shortcut: tip-only check misses a mid-history edit that keeps the last
        //   assistant id, upgrade to a full-history digest if that ever matters.
        if (isTurn && webSessionId && !pending.rebuild) {
          const tip = await history(credential, webSessionId, options.signal);
          if (tip) {
            const lastAssistant = [...tip].reverse().find((m) => m.role === 'assistant');
            const webTip = lastAssistant && Number.isInteger(lastAssistant.id) ? lastAssistant.id : 0;
            if (webTip !== map.parentFor(key)) {
              map.setParent(key, webTip);
            }
          }
        }
        const prompt = promptFor(pending.fresh, pending.rebuild, options.tools, options.system);
        if (!prompt) {
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        if (!webSessionId || pending.rebuild) {
          webSessionId = await create(credential, options.signal);
          fresh = isTurn;
          if (isTurn) map.bind(key, webSessionId, protocol);
        }
        await pace.wait(options.signal);

        const readTurn = async (promptText, parent) => {
          let text = '';
          let think = '';
          let tip = '';
          let mid = 0;
          for await (const event of complete(
            credential,
            {
              sessionId: webSessionId,
              prompt: promptText,
              modelType: 'default',
              thinking: false,
              search: false,
              parentMessageId: parent,
            },
            options.signal,
          )) {
            if (event.type === 'text') {
              text += event.text;
              produced = true;
            } else if (event.type === 'thinking') {
              think += event.text;
              produced = true;
            } else if (event.type === 'note') {
              tip = event.text || tip;
              produced = true;
            } else if (event.type === 'message') {
              mid = event.messageId;
              produced = true;
            }
            else if (event.type === 'error') throw new Error(event.error || 'DeepSeek 网页生成失败');
          }
          if (tip) text += `\n\n${tip}`;
          return { text, think, mid };
        };

        let turn = await readTurn(prompt, isTurn ? map.parentFor(key) || null : null);
        let answer = turn.text;
        let reasoning = turn.think;
        let messageId = turn.mid;
        // A pure <result> echo means the model presented the output instead of
        // continuing; nudge once, then take whatever it says.
        if (isTurn && /^\s*<result\b[\s\S]*<\/result>\s*$/i.test(answer)) {
          turn = await readTurn('继续。不要重复上面的命令输出。', messageId);
          answer = turn.text;
          reasoning = turn.think;
          messageId = turn.mid;
        }

        // The answer is buffered because a tool call has to be parsed before any
        // of it can be emitted as text. Agent turns are not the panel's token
        // stream, so the end-of-turn wait costs nothing here.
        let index = 0;
        const emitText = function* emitText(value) {
          if (!value.trim()) return;
          const blockIndex = index++;
          yield { type: 'block-start', index: blockIndex, blockType: 'text' };
          yield { type: 'text-delta', index: blockIndex, text: value };
          yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: value } };
        };
        const emitReasoning = function* emitReasoning(value) {
          if (!value.trim()) return;
          const blockIndex = index++;
          yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' };
          yield { type: 'reasoning-delta', index: blockIndex, text: value };
          yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: value } };
        };
        const emitToolCall = function* emitToolCall(call) {
          const blockIndex = index++;
          const id = `call_${blockIndex}_${Date.now().toString(36)}`;
          yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: call.arguments };
          yield {
            type: 'block-end',
            index: blockIndex,
            block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
          };
        };

        yield* emitReasoning(reasoning);
        let sawCall = false;
        for (const block of parseAnswer(answer, options.tools)) {
          if (block.type === 'tool-call') {
            sawCall = true;
            yield* emitToolCall(block);
          } else yield* emitText(block.text);
        }
        if (isTurn) {
          if (messageId > 0) map.setParent(key, messageId);
          map.commit(key, messages, protocol);
        }
        yield { type: 'finish', reason: { kind: sawCall ? 'tool-calls' : 'stop' } };
      } catch (error) {
        // A brand-new web session that produced nothing is dead weight: forget it
        // so the retry rebuilds instead of sending a delta into an empty chat.
        // Once any output arrived, keep the branch; the retry can continue it.
        if (fresh && !produced) map.forget(key);
        throw error;
      } finally {
        release();
      }
    },
  };
}
