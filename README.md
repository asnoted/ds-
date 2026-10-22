# dsb

一个用户友好的dsweb插件

## 开发启动

```sh
uv run dsb up
```

这一条命令会依次完成:构建浏览器扩展(`pnpm build`) → 拉起带独立 profile 的浏览器(`dsb env up`) → 启动本机 MCP 网关(监听端口,若端口被旧进程占用会自动接管).按 `Ctrl-C` 即可退出网关.

## 核心链路

一圈的交互图:

![自动续聊:一圈是怎么转的](docs/diagrams/continuation-round.svg)

## 限速

beta(2,4) 3-6-15 唯一限速

## 提示

本文只给人类读

## 参考

- [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant):把 MCP 带进网页版 AI
