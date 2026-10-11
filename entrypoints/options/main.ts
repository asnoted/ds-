import { browser } from "wxt/browser";

import {
  describeLastFailure,
  readFailureLog,
  FAILURE_LOG_STORAGE_KEY,
} from "../../src/lib/failurelog";
import { readSpeak, SPEAK_STORAGE_KEY } from "../../src/lib/toggle";

const checkbox = document.querySelector<HTMLInputElement>("#speak");
if (checkbox !== null) {
  void browser.storage.local.get(SPEAK_STORAGE_KEY).then((stored) => {
    checkbox.checked = readSpeak(stored[SPEAK_STORAGE_KEY]);
  });
  checkbox.addEventListener("change", () => {
    void browser.storage.local.set({ [SPEAK_STORAGE_KEY]: checkbox.checked });
  });
}

/**
 * "上次故障"那一行(#52):读既有的失败痕,把最近一条摆出来.
 *
 * **不新增任何上报**--失败痕早就记了(ADR-0004),这里只是把它摆到选项页.
 * 好处是 8 轮到顶停手(环节 `rounds`)与续聊那一跳的各种失败(#51 新加的
 * `continuation`)都能在这里看见,不必去翻控制台.
 */
const lastFailure = document.querySelector<HTMLElement>("#last-failure");
if (lastFailure !== null) {
  void browser.storage.local
    .get(FAILURE_LOG_STORAGE_KEY)
    .then((stored) => {
      const described = describeLastFailure(
        readFailureLog(stored[FAILURE_LOG_STORAGE_KEY]),
        Date.now(),
      );
      lastFailure.textContent =
        described === null ? "还没出过事." : `上次故障:${described.slice("上次故障 ".length)}`;
    })
    .catch(() => {
      // 读不到就当没出过事,不摆一句错的话.
      lastFailure.textContent = "";
    });
}
