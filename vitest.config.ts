import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // vendor/ 那批是别人家的代码，本仓的测试不该连带它一起跑
    exclude: ["**/node_modules/**", "**/vendor/**"],
  },
});
