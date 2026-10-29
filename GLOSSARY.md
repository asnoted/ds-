# ds-

dsh-dsweb + dsh-dsb

## Language

**工具协议**:

围栏标签就是工具名, 正文是原生 JSON 参数对象 (单参数工具可直接写原文):

````
```bash
{"command": "ls -a", "description": "List files"}
```
````

````
```run_code
{"code": "return 1", "description": "Return one"}
```
````

模型只写参数对象、不带工具名时, 按唯一匹配的 schema 认领. 见 dsweb/lib/web-model.js 的 toolProtocol.

_Avoid_: 工具调用块, `tool` 围栏, {name:params}

**限额**:
单通道长间隔,beta(2,4)缩放至(3,15)大致能过

_Avoid_: 配额,节流,限流
