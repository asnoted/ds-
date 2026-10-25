import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // vendor/ 那批是别人家的代码，本仓的测试不该连带它一起跑
    exclude: ["**/node_modules/**", "**/vendor/**"],
    // wait.test.ts 的 timeout 只有 1 秒，文件并发跑会把预算挤掉
    fileParallelism: false,
  },
});
