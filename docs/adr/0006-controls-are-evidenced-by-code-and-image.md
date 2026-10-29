# ADR-0006: 将网页操作制作为公开接口

- **Status**: accepted — 历史文档: 所描述的 Python 中继 + 浏览器扩展在 3d0c51a 已删除, 现行实现是 dsweb/lib 与 dsb/lib 两个 DSH 插件
- **Date**: 2026-10-17

**最小单元** = 页面动作名册按控件划出的最小粒度(一个按钮只能对应一个动作).

## 决定

1. **按钮的代码**: 真机抓到的 `outerHTML`
2. **按钮的图片**: 它的png图,真机截图验证

## Considered Options

## Consequences

## 判据(怎么自己复现)

- 见 `docs/evidence/controls.md`.
