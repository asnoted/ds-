"""守卫:不直连站点(拟人操作的硬边界).

拟人操作是硬约定,不是风格偏好:**只走页面可见动作**,不 hook 网络侦查,不直连站点接口,
不碰站点令牌;CDP 只可读渲染 DOM 与重载.出事的代价是账号,不是构建红,所以这里做静态
体检,宁可误伤也要它当场喊--**不得有第二次**.

天花板(ponytail):这里查的是**字面量**.站点地址写成变量,拼接,或从别处传进来就漏过去,
测试文件也被豁免(它们要凭空造站点地址).真正兜底的是 `permissions` 那一行:不给
cookies / webRequest / debugger,浏览器层面就拿不到那些能力.想扩权先改 wxt.config.ts,
改完第 1 条必红.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: 要体检的源码面;构建产物(.output/)不算代码.
SCANNED = ("src", "entrypoints", "dsb", "wxt.config.ts")

#: 站点地址只许活在这几处:manifest 钉权限,两个内容脚本钉 matches,两个常量认标签页.
#: 本机这半(dsb/)不在册--网关必须对站点全盲.
SITE_ADDRESS_ALLOWED = frozenset(
    {
        "wxt.config.ts",
        "entrypoints/content.ts",
        "entrypoints/inject.content.ts",
        "src/lib/inject.ts",
        "src/lib/action.ts",
    }
)

#: 站点的地址与接口路径:拿它们**认**是站点的事(认标签页,认出站请求,认围栏),
#: 拿它们**发请求**是另一回事.
SITE_API = re.compile(r"deepseek\.com|/api/v\d+/chat|chat/completion", re.I)

#: 出站调用的实参(从实参起,到分号为止,最多 200 字符).
OUTBOUND = re.compile(r"(?:fetch|sendBeacon)\s*\(([^;]{0,200})|\.open\s*\(([^;]{0,200})", re.S)

#: 站点的令牌只该待在页面自己那儿.认得的读法只有这几样--注意**不含** 扩展自己的
#: `chrome.storage`(总开关与故障留痕归它,不归站点).
SITE_SECRETS = re.compile(
    r"chrome\.cookies|browser\.cookies|document\.cookie|localStorage|sessionStorage"
)

#: 接浏览器调试口.ADR-0007 判过不上;真要上得先按"只读渲染 DOM,只重载"改这条.
CDP = re.compile(r"chrome\.debugger|devtools|:9222")

_SOURCES_CACHE: dict[str, str] | None = None


def _sources() -> dict[str, str]:
    """扫描面 → 正文;测试文件豁免(它们要凭空造站点地址来对拍)."""
    global _SOURCES_CACHE
    if _SOURCES_CACHE is None:
        out: dict[str, str] = {}
        for name in SCANNED:
            path = ROOT / name
            files = (
                [path]
                if path.is_file()
                else [f for f in path.rglob("*") if f.suffix in {".ts", ".py", ".mjs"}]
            )
            for f in files:
                if ".test." in f.name:
                    continue
                out[str(f.relative_to(ROOT))] = f.read_text(encoding="utf-8")
        _SOURCES_CACHE = out
    return _SOURCES_CACHE


def _manifest_array(key: str, text: str) -> list[str]:
    """`wxt.config.ts` 里那个数组的字符串项(`\\b` 保证不会被 host_permissions 顶掉)."""
    body = re.search(rf"\b{key}:\s*\[(.*?)\]", text, re.S)
    assert body is not None, f"wxt.config.ts 里找不到 {key}"
    return re.findall(r'"([^"]+)"', body.group(1))


def test_the_manifest_does_not_ask_for_a_way_into_the_site_behind_its_back() -> None:
    """浏览器权限钉死在两个,都与站点范围无关;不给 cookie,webRequest,debugger."""
    text = (ROOT / "wxt.config.ts").read_text(encoding="utf-8")
    assert _manifest_array("permissions", text) == ["storage", "alarms"]


def test_host_permissions_are_the_site_and_this_machine_only() -> None:
    """站点只许一个精确条目,其余全是指向本机中继的回环地址."""
    entries = _manifest_array(
        "host_permissions", (ROOT / "wxt.config.ts").read_text(encoding="utf-8")
    )
    site = [entry for entry in entries if "deepseek" in entry]
    assert site == ["https://chat.deepseek.com/*"], site
    rest = [entry for entry in entries if entry not in site]
    assert rest, "中继的回环地址一条都没了"
    assert all(entry.startswith(("http://127.0.0.1", "http://localhost")) for entry in rest), rest


def test_the_site_address_only_lives_in_a_handful_of_known_places() -> None:
    """站点地址只许在钉权限,钉 matches,认标签页那几处出现.

    这条同时把本机这半钉死:dsb/ 不在册,它一旦提到站点当场红.
    """
    seen = {name for name, text in _sources().items() if SITE_API.search(text)}
    assert seen <= SITE_ADDRESS_ALLOWED, sorted(seen - SITE_ADDRESS_ALLOWED)


def test_no_source_asks_the_site_for_anything() -> None:
    """出站调用的实参里不出现站点 host,也不出现站点接口的路径."""
    for name, text in _sources().items():
        for match in OUTBOUND.finditer(text):
            args = match.group(1) if match.group(1) is not None else match.group(2) or ""
            assert not SITE_API.search(args), f"{name}:{match.group(0)[:160]}"


def test_no_source_reads_site_credentials() -> None:
    """站点的令牌不进代码:cookie,存储一律不碰,令牌只该待在页面自己那儿."""
    for name, text in _sources().items():
        match = SITE_SECRETS.search(text)
        assert match is None, f"{name}:读了 {match.group(0)}"


def test_no_source_wires_up_cdp() -> None:
    """不接浏览器调试口:要读页面走内容脚本(ADR-0007 判过外挂 CDP 不上)."""
    for name, text in _sources().items():
        match = CDP.search(text)
        assert match is None, f"{name}:接了调试口 {match.group(0)}"
