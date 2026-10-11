import { browser } from "wxt/browser";

import { readToggle, TOGGLE_STORAGE_KEY } from "../../src/lib/toggle";

// 总开关只存在 storage.local(默认关):这里读出来显示,拨动写回去.
// background 监听 storage.onChanged,写完即重算三态,角标与通道--
// 面板不用自己跟 background 对话.
const checkbox = document.querySelector<HTMLInputElement>("#toggle");
if (checkbox !== null) {
  void browser.storage.local.get(TOGGLE_STORAGE_KEY).then((stored) => {
    checkbox.checked = readToggle(stored[TOGGLE_STORAGE_KEY]);
  });
  checkbox.addEventListener("change", () => {
    void browser.storage.local.set({ [TOGGLE_STORAGE_KEY]: checkbox.checked });
  });
}
