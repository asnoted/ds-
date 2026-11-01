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

export function normalizeToken(raw) {
  let value = typeof raw === 'string' ? raw.trim() : '';
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
