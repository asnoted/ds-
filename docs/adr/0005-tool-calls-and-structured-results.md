# ADR-0005: 工具调用用紧凑 JSON; 工具结果回返用toon,人类可读

- **Status**: accepted — 历史文档: 所描述的 Python 中继 + 浏览器扩展在 3d0c51a 已删除, 现行实现是 dsweb/lib 与 dsb/lib 两个 DSH 插件
- **Date**: 2026-10-17

"工具调用与工具结果的形状":

**工具调用(页面 <-> 中继)紧凑 JSON**

## 决定

1. **紧凑 JSON 落在出口一处**

## Considered Options

- 见正文与 `tests/test_mcp_envelope.py`.

## Consequences

- 见正文与 `tests/test_mcp_envelope.py`.

## 判据(怎么自己复现)

- 见 `tests/test_mcp_envelope.py`.
- 实测见 `docs/evidence/structured-results.md`.
