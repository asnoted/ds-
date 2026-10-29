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
 * calls them with DSML invoke blocks that {@link parseAnswer} turns back into
 * tool-call blocks.
 *
 * @module dsh-dsb/web-model
 */

import { createPacer } from './pace.js';
import { createSessionMap } from './session-map.js';
import { createSession, fetchMessages, streamCompletion } from './deepseek.js';
import { readVault } from './vault.js';

export const PROVIDER = 'deepseek-web';
export const MODEL = 'deepseek-web';
const CONTEXT_WINDOW = 128_000;

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

function toolProtocol(tools) {
  const list = namedTools(tools);
  const bar = "｜｜DSML｜｜";
  return [
    'You can call tools by emitting DeepSeek DSML invoke blocks. Only the tools listed below exist. Do not use any other tool-call syntax.',
    'A call looks like: <' + bar + 'invoke name="TOOLNAME"><' + bar + 'parameter name="ARG">VALUE</' + bar + 'parameter></' + bar + 'invoke>',
    'For bash, the argument is "command": <' + bar + 'invoke name="bash"><' + bar + 'parameter name="command">ls -la</' + bar + 'parameter></' + bar + 'invoke>',
    'Text outside the invoke blocks is shown to the user. You may emit several calls in one answer.',
  ].join('\n');
}

// The web model emits the token's bar count inconsistently, and sometimes
// merges a closing tag with the next opening tag. Accept all observed shapes.
const DSML_TAG = '｜{0,2}DSML｜{0,2}';
const DSML_INVOKE = new RegExp(
  `<${DSML_TAG}\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)(?:<\\/${DSML_TAG}\\s*invoke\\s*>|<\\/${DSML_TAG}\\s*calls\\s*>|<\\/${DSML_TAG}\\s*>|$)`,
  'g',
);
const DSML_PARAM = new RegExp(
  `<${DSML_TAG}\\s*parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)<\\/${DSML_TAG}\\s*parameter\\s*>`,
  'g',
);
const DSML_CLOSE_PARAM = new RegExp(`<\\/(${DSML_TAG})\\s*parameter\\s+name=`, 'g');
const DSML_CLOSE_INVOKE = new RegExp(`<\\/(${DSML_TAG})\\s*invoke\\s+name=`, 'g');

/** Split `</invoke name="x">` into a close and a new open, same for parameters. */
function normalizeDsml(raw) {
  return raw
    .replace(DSML_CLOSE_PARAM, (_match, tag) => `</${tag} parameter>\n<${tag} parameter name=`)
    .replace(DSML_CLOSE_INVOKE, (_match, tag) => `</${tag} invoke>\n<${tag} invoke name=`);
}

/** Use the tool schema's type as the authority, falling back to the DSML flag. */
function coerceArg(value, schema, stringFlag) {
  const type = schema && typeof schema === 'object' ? schema.type : undefined;
  if (type === 'string') return value;
  if (type === 'number' || type === 'integer') {
    const number = Number(value);
    return value !== '' && Number.isFinite(number) ? number : value;
  }
  if (type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (type === 'array' || type === 'object' || stringFlag === 'false') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function dsmlArgs(raw, tool) {
  const body = normalizeDsml(raw);
  const properties = tool && tool.parameters && typeof tool.parameters === 'object'
    ? tool.parameters.properties
    : undefined;
  const args = {};
  let malformed = false;
  for (const match of body.matchAll(DSML_PARAM)) {
    const [, name, attributes, value] = match;
    const v = value.trim();
    if (v.includes('parameter name=') || v.includes('invoke name=')) malformed = true;
    const stringFlag = /\bstring\s*=\s*"?(true|false)"?/.exec(attributes);
    args[name] = coerceArg(v, properties && properties[name], stringFlag && stringFlag[1]);
  }
  // A parameter-shaped body that yielded nothing means the tag was malformed;
  // turning it into an empty call would run a tool with `{}` by accident.
  if (Object.keys(args).length === 0 && /parameter\s+name=/.test(body)) malformed = true;
  return { args, malformed };
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
  }
  return lines.length === 0 ? '' : `${toolProtocol(list)}\n\nTOOL CATALOG\n${lines.join('\n')}`;
}

/** A model that loses the thread can repeat a call forever; 9 bounds one answer's damage. */
const MAX_TOOL_CALLS = 9;

/**
 * Split a buffered answer into text and tool calls.
 *
 * Only DSML invoke blocks are recognized: the prompt teaches exactly that
 * shape. Anything else — the web app's own/memory calls, a markdown code
 * sample, a malformed block — stays visible text. A call is only taken when
 * its name is an active DSH tool.
 */
function parseAnswer(answer, tools) {
  const byName = new Map(namedTools(tools).map((tool) => [tool.name, tool]));
  if (byName.size === 0) return [{ type: 'text', text: answer }];
  const normalized = normalizeDsml(answer);
  const blocks = [];
  const state = { calls: 0, truncated: false };
  let last = 0;
  for (const match of normalized.matchAll(DSML_INVOKE)) {
    const before = normalized.slice(last, match.index);
    if (before) blocks.push({ type: 'text', text: before });
    const name = match[1];
    const parsed = dsmlArgs(match[2], byName.get(name));
    const malformed = parsed.malformed || match[2].includes('invoke name=');
    if (!byName.has(name) || malformed || state.calls >= MAX_TOOL_CALLS) {
      if (byName.has(name) && !malformed) state.truncated = true;
      blocks.push({ type: 'text', text: match[0] });
    } else {
      state.calls += 1;
      blocks.push({ type: 'tool-call', name, arguments: JSON.stringify(parsed.args) });
    }
    last = match.index + match[0].length;
  }
  const tail = normalized.slice(last);
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
        const pending = isTurn ? map.pending(key, messages) : { fresh: messages, rebuild: true };
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
          if (isTurn) map.bind(key, webSessionId);
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
          map.commit(key, messages);
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
