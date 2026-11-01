/**
 * Accept every shape the user can realistically paste or the browser can hand
 * over.
 *
 * chat.deepseek.com keeps its session in `localStorage.userToken`, which is a
 * JSON envelope (`{"value":"<token>","__version":"0"}`), and DevTools users
 * often copy the whole `Authorization: Bearer …` header instead. All three
 * forms are normalized to the bare token.
 *
 * @module dsh-dsb/token
 */

/** One unwrapping pass: bearer prefix, JSON envelope, stray quotes, whitespace. */
function stripPass(raw) {
  let value = raw.trim();
  if (!value) return '';
  value = value.replace(/^Bearer\s+/i, '').trim();
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      const inner = parsed && typeof parsed.value === 'string' ? parsed.value : '';
      if (inner) value = inner.trim();
    } catch {
      /* not an envelope: keep the literal text */
    }
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/\s+/g, '');
}

export function normalizeToken(raw) {
  let value = stripPass(typeof raw === 'string' ? raw : '');
  // Repeat until stable so a quoted envelope (a DevTools copy of the whole
  // localStorage value) still lands on the bare token; every pass only removes
  // characters, so this terminates.
  while (value) {
    const stripped = stripPass(value);
    if (stripped === value) break;
    value = stripped;
  }
  return value;
}
