/**
 * Chat-paced agent loop — a subclass of the host `@deepseek-ai/dsh-agent-loop`.
 *
 * The web side (routes, vault, login, `deepseek-web` model) lives in `dsh-dsweb`.
 * This class reuses the host loop's turn/step machinery through the host's own
 * module instance and will override the pieces that make a chat rhythm.
 *
 * @module dsh-dsb
 */

import { loadHostLoop } from './host.js';

const { AgentLoop } = await loadHostLoop();

export class ChatLoop extends AgentLoop {
  static inject = AgentLoop.inject;
  static Config = AgentLoop.Config;
}

export default ChatLoop;
