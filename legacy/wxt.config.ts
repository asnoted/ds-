import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "dsb",
    permissions: ["storage", "tabs", "alarms", "activeTab"],
    host_permissions: ["<all_urls>"],
  },
});
