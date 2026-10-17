/**
 * 归一化到"能不能与短标记逐字相等"的口径(ADR-0005):**只放宽两处**--换行统一
 * (CRLF/LF),去首尾空白;其余字符(含文内空白)仍严格相等.
 *
 * 两把钥匙共用这一份:武装的钥匙比对(`armed.ts` 的 `matchesMarker`)与落草稿是不是
 * 同一份字(`composer.ts` 的 `sameText`).两处各写一遍就是两份会漂移的口径,
 * 而口径一漂,等于换了一把钥匙.
 */

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}
