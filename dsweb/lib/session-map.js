/**
 * One DSH session ↔ one web chat session.
 *
 * DSH replays its whole message log every step, while a web completion takes
 * `(sessionId, prompt)` and keeps the history server-side. This map remembers
 * how much of the DSH log the web session has already seen, so a later step can
 * send only the delta.
 *
 * A digest of the sent prefix catches compaction or a rewritten history. On a
 * mismatch the caller must rebuild the web session from the current log instead
 * of sending a delta on top of stale server-side history — that fallback is what
 * keeps the model-visible input reconstructable from the DSH log.
 *
 * @module dsh-dsb/session-map
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const VERSION = 1;
const FILE = 'web-sessions.json';

/** Kept local so the map does not depend on whichever package owns the vault. */
function defaultFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-dsb', FILE);
}

function digest(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function empty() {
  return { version: VERSION, sessions: {} };
}

function load(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && parsed.version === VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed;
    }
  } catch {
    /* missing or unreadable map starts empty */
  }
  return empty();
}

/**
 * Create the map. `file` is injectable for tests; production keeps it beside the
 * plugin's other state so the mapping survives a DSH restart.
 */
export function createSessionMap({ file = defaultFile() } = {}) {
  const data = load(file);

  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
  };

  return {
    /** Web session already bound to a DSH session, or '' when unbound. */
    webSessionFor(dshSessionId) {
      const entry = data.sessions[dshSessionId];
      return entry && typeof entry.webSessionId === 'string' ? entry.webSessionId : '';
    },

    /** Bind a freshly created web session; nothing has been sent yet. */
    bind(dshSessionId, webSessionId) {
      data.sessions[dshSessionId] = {
        webSessionId,
        parentMessageId: 0,
        cursor: 0,
        digest: digest([]),
        updatedAt: new Date().toISOString(),
      };
      save();
    },

    /**
     * Assistant message the next prompt must continue from.
     *
     * A web completion with `parent_message_id: null` starts a new branch and
     * answers without the session history, so every later turn has to pass the
     * previous assistant message id.
     */
    parentFor(dshSessionId) {
      const entry = data.sessions[dshSessionId];
      return entry && Number.isInteger(entry.parentMessageId) && entry.parentMessageId > 0
        ? entry.parentMessageId
        : 0;
    },

    setParent(dshSessionId, messageId) {
      const entry = data.sessions[dshSessionId];
      if (!entry || !Number.isInteger(messageId) || messageId <= 0) return false;
      entry.parentMessageId = messageId;
      entry.updatedAt = new Date().toISOString();
      save();
      return true;
    },

    /**
     * Messages the web session has not seen yet.
     *
     * `rebuild` means the stored prefix no longer matches the log (compaction,
     * edit, resume against a foreign web session): the caller creates a new web
     * session and sends `fresh` — the full current log — as its first prompt.
     */
    pending(dshSessionId, messages) {
      const entry = data.sessions[dshSessionId];
      if (!entry || !entry.webSessionId) {
        return { fresh: messages, rebuild: true, cursor: 0 };
      }
      if (entry.cursor > messages.length) {
        return { fresh: messages, rebuild: true, cursor: 0 };
      }
      const seen = messages.slice(0, entry.cursor);
      if (digest(seen) !== entry.digest) {
        return { fresh: messages, rebuild: true, cursor: 0 };
      }
      return { fresh: messages.slice(entry.cursor), rebuild: false, cursor: entry.cursor };
    },

    /**
     * Record that the log prefix up to `messages.length` reached the web session.
     *
     * shortcut: a crash between the web turn and this write re-sends the delta
     * on restart (at-least-once), upgrade with an upstream turn id if duplicate
     * prompts ever matter.
     */
    commit(dshSessionId, messages) {
      const entry = data.sessions[dshSessionId];
      if (!entry) return false;
      entry.cursor = messages.length;
      entry.digest = digest(messages);
      entry.updatedAt = new Date().toISOString();
      save();
      return true;
    },

    forget(dshSessionId) {
      delete data.sessions[dshSessionId];
      save();
    },
  };
}
