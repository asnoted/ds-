import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "dsb",
    description: "在 DeepSeek 网页里直接调用本机 MCP 工具",
    // 站点范围在装的那一刻定死,运行期不接受任何切换;总开关不参与站点判定.
    // `<all_urls>` 是唯一的例外,只解锁一件事:失败当场抓一帧(ADR-0008,#106).
    // `captureVisibleTab` 的硬要求就是 `<all_urls>` 或 activeTab,站点级 host 权限
    // 不算数--实机证伪过,判据是 `uv run scripts/page-action.py visible-capture`.
    // 它盖住了原来那几条(站点域与中继的 127.0.0.1/localhost);内容脚本的注入范围
    // 照旧钉在 chat.deepseek.com(见各 entrypoint 的 matches),中继仍是直连免 CORS
    // 那条路(ADR-0002).
    host_permissions: ["<all_urls>"],
    // 浏览器权限只有两个,都跟站点范围无关:storage 存总开关(默认关),
    // alarms 排周期探活(开关开着才排,30s 一次).站点权限与浏览器权限分开,
    // 不靠任何浏览器权限去扩站点范围.
    permissions: ["storage", "alarms"],
    // 工具栏图标即状态位(三态像素与悬停文案由 background 现算);
    // popup(entrypoints/popup/index.html,WXT 自动注册为 default_popup)
    // 只放总开关--点图标开它,不再直接切开关.
    // 静态图标是 background 还没 setIcon 前的兜底,画的是 "off" 态(默认关).
    action: {
      default_title: "dsb",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
      },
    },
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
  },
});
