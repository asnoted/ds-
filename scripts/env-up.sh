#!/usr/bin/env bash
# 环境准备：起缺的、**旧代码自动换**（ds-browser 装的扩展比构建旧会自动
# 重启；中继跑旧代码提示 kill），最后拿真判据验一次。
# 用法：scripts/env-up.sh [--status] [--debug]
#   --status 只读汇总
#   --debug  让 ds-browser 带 --remote-debugging-port（开发探针用；见 scripts/page-action.py）
# 幂等，可反复跑。
#
# 两件人做的事（脚本做不了）在末尾打印，不猜、不代劳。
set -uo pipefail
cd "$(dirname "$0")/.."

# 平台：原来只认 macOS（/Applications 下的 Chromium、`stat -f`、`lsof`、`open -a`）。
# 换到 Linux 全落空——而 nohup 的报错只进 /tmp/dsb-browser.log，浏览器那一步会
# **谎报已起**，接着判据全红。这里按 uname 分两路。
UNAME_S=$(uname -s)
if [ "$UNAME_S" = "Darwin" ]; then
  CHROME="${CHROME:-/Applications/Chromium.app/Contents/MacOS/Chromium}"
  PROFILE="${DSB_PROFILE:-$HOME/Library/Application Support/ds-browser}"
else
  CHROME="${CHROME:-}"
  if [ -z "$CHROME" ]; then
    for candidate in chromium chromium-browser google-chrome google-chrome-stable brave-browser microsoft-edge; do
      if found=$(command -v "$candidate" 2>/dev/null); then CHROME=$found; break; fi
    done
  fi
  PROFILE="${DSB_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/ds-browser}"
fi
MV3="$PWD/.output/chrome-mv3"
PORT=8787
MCP="http://127.0.0.1:$PORT/mcp"

say() { printf '  %-8s %s\n' "$1" "$2"; }

# 文件 mtime（秒）：BSD 是 `stat -f %m`，GNU 是 `stat -c %Y`。不分开就静默拿到空串，
# 「装的扩展比构建旧」这条判据永远不会响。
if [ "$UNAME_S" = "Darwin" ]; then MTIME=(stat -f %m); else MTIME=(stat -c %Y); fi

# 监听 $PORT 的 pid：lsof 不一定装（Linux 上常常没有），ss 兜底。
listener_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
  fi
}

# ds-browser 的主进程**带没带 --load-extension**：不带就是「浏览器在跑，扩展却没装进来」。
# 只看进程在不在的话，手动开的窗口会被判成「已在跑」，扩展永远进不来——图标找不到就是这么来的。
browser_loaded_extension() {
  if [ "$UNAME_S" = "Darwin" ]; then
    ps -p "$1" -o command= 2>/dev/null | grep -q -- '--load-extension='
  else
    tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null | grep -q -- '--load-extension='
  fi
}

# 只动 ds-browser 这一个进程：SIGTERM → 等它自己退 → 还不走再 -9。用户的别的浏览器一律不碰。
kill_browser() {
  kill "$1" 2>/dev/null
  for _ in 1 2 3 4 5; do
    ps -p "$1" >/dev/null 2>&1 || break
    sleep 1
  done
  kill -9 "$1" 2>/dev/null
}

# 一行 JSON-RPC 打 /mcp：唯一端点（ADR-0011）——自检 initialize、
# 查表 tools/list 都走它；扩展的周期探活是 ping（dsb 记日志）。
rpc() {
  curl -s -m 10 -X POST "$MCP" -H 'Content-Type: application/json' -d "$1"
}

# 起 ds-browser：先清 SW 脚本缓存（扩展版本号不变时，Chromium 把 SW
# 脚本缓存在 profile 里一直沿用——实测 SW 跑一天前的旧脚本，重启十几回
# 都不换；内容脚本却随页面加载新构建，症状是「读类动作新、写类动作旧」）。
# Database 是 SW 注册表（可再生成、无用户数据），一并清。
start_browser() {
  if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then
    say 浏览器 "找不到 Chromium 系浏览器（找过 chromium / google-chrome / brave…）——装了再重跑"
    exit 1
  fi
  mkdir -p "$PROFILE"
  rm -rf "$PROFILE/Default/Service Worker/ScriptCache" "$PROFILE/Default/Service Worker/Database"
  # 上一回是本脚本 kill 掉的：Chromium 记 exit_type=Crashed，下次启动会把旧标签页
  # （含上一次的空白新标签页）恢复回来。环境准备反正会关掉旧标签页，这里把会话恢复
  # 状态一并清掉，保证只剩命令行带的那个会话页。
  rm -rf "$PROFILE/Default/Sessions" "$PROFILE/Default/Last Session" "$PROFILE/Default/Last Tabs"
  # 起进程的同时把会话页当**首个标签页**：不带 URL 时独立 profile 会先开一个空白
  # 新标签页，判据 3 再开一次就多出一个标签页。URL 跟在这里，一次到位。
  if [ "${DEBUG:-0}" = 1 ]; then
    "$CHROME" --user-data-dir="$PROFILE" --load-extension="$MV3" \
      --remote-debugging-port="${DEBUG_PORT:-9222}" \
      --no-first-run --no-default-browser-check "https://chat.deepseek.com/" \
      >/tmp/dsb-browser.log 2>&1 &
  else
    "$CHROME" --user-data-dir="$PROFILE" --load-extension="$MV3" \
      --no-first-run --no-default-browser-check "https://chat.deepseek.com/" \
      >/tmp/dsb-browser.log 2>&1 &
  fi
  disown
  # 起了得回头看它一眼：nohup 的报错只进日志，不看就等于「谎报已起」
  # （macOS 那条路径在 Linux 上就是这样，一路骗到判据 2 才炸）。
  sleep 2
  if [ -z "$(browser_main_pid)" ]; then
    say 浏览器 "没起来 → /tmp/dsb-browser.log"
    tail -3 /tmp/dsb-browser.log 2>/dev/null | sed 's/^/           /'
    exit 1
  fi
  STARTED_BROWSER=1
  # 注意 `${CHROME}` 的花括号：**紧跟的全角括号是合法标识符字符**，写成 `$CHROME（…`
  # 会被 bash 当成变量名 `CHROME（…`，`set -u` 下当场报 `unbound variable`（2026-10-05 修）。
  say 浏览器 "已起 → ${CHROME}（独立 profile：${PROFILE}，清过 SW 脚本缓存与会话恢复，带会话标签页）"
}

# ds-browser 的主进程 PID：主进程的首个 flag 是 --user-data-dir，
# 子进程是 --type=，据此只数主进程。没有回空。
browser_main_pid() {
  if [ "$UNAME_S" = "Darwin" ]; then
    ps ax -o pid=,command= | grep -E "^ *[0-9]+ $CHROME --user-data-dir=$PROFILE" | head -1 | awk '{print $1}'
  else
    pgrep -f -- "--user-data-dir=$PROFILE" 2>/dev/null | while read -r pid; do
      [ -r "/proc/$pid/cmdline" ] || continue
      tr '\0' '\n' < "/proc/$pid/cmdline" | grep -q -- '--type=' || { printf '%s\n' "$pid"; break; }
    done
  fi
}

# 任意进程的启动时刻（epoch 秒；拿不到回空）。ps 的 lstart 日是
# 空格填充的，先压成单空格再解析。
proc_started() {
  LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null | python3 -c '
import sys
from datetime import datetime
raw = " ".join(sys.stdin.read().split())
try:
    print(int(datetime.strptime(raw, "%a %b %d %H:%M:%S %Y").timestamp()))
except ValueError:
    print("")'
}

# 扩展最后探活距今几秒：读候选日志里最后一条 `] ping` 行（事件名
# 固定、无字段，是 dsb/mcp.py 的 ping 分支留的）。候选是 env-up
# 起的中继（/tmp/dsb-relay.log）与 dsb/log.py 约定的自起写法
# （/tmp/dsb.log）。回 -1 = 候选日志一个都读不开（中继可能不是
# 本脚本起的、日志在别处）；-2 = 日志读到了但没有探活痕迹（扩展
# 没探活，或中继跑旧代码不记 ping）。总开关关着时扩展不探活——
# 「没有新痕迹」是常态，不是故障。
last_probe_age() {
  python3 - <<'PY'
from datetime import datetime

now = datetime.now()
readable = False
best = None
for path in ("/tmp/dsb-relay.log", "/tmp/dsb.log"):
    try:
        with open(path, errors="replace") as handle:
            readable = True
            for line in handle:
                if not line.rstrip().endswith("] ping"):
                    continue
                try:
                    when = datetime.strptime(line[1:20], "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    continue
                if best is None or when > best:
                    best = when
    except OSError:
        continue
if not readable:
    print(-1)
elif best is None:
    print(-2)
else:
    print(max(0, int((now - best).total_seconds())))
PY
}

# ---- 中继的两个判据（放在 --status 之前：只读汇总也要报「跑的是旧代码」）----
start_relay() {
  nohup pnpm relay:dev >/tmp/dsb-relay.log 2>&1 &
  disown
}

# dsb 跑的是旧代码的两个信号：压根不答 initialize（旧代码连 /mcp 路由都没有），
# 或源码比进程新（长驻进程不重载代码）。
relay_is_stale() {
  local pid=$1
  rpc '{"jsonrpc":"2.0","id":"status","method":"initialize"}' | grep -q '"result"' || return 0
  local newest started
  newest=$(find dsb -name '*.py' -exec "${MTIME[@]}" {} + 2>/dev/null | sort -rn | head -1)
  started=$(proc_started "${pid:-0}")
  if [ -n "$newest" ] && [ -n "$started" ] && [ "$newest" -gt "$started" ]; then return 0; fi
  return 1
}

# 只动中继那一个进程：SIGTERM → 等它自己退 → 还不走再 -9。
stop_relay() {
  kill "$1" 2>/dev/null
  for _ in 1 2 3 4 5; do
    ps -p "$1" >/dev/null 2>&1 || break
    sleep 1
  done
  kill -9 "$1" 2>/dev/null
}

# ---- --status：只读汇总，不改动任何东西 ----
STATUS=0
DEBUG=0
DEBUG_PORT=9222
for arg in "$@"; do
  case "$arg" in
    --status) STATUS=1 ;;
    --debug) DEBUG=1 ;;
    *) say 提示 "忽略未知参数：$arg" ;;
  esac
done

if [ "$STATUS" = 1 ]; then
  if [ ! -f "$MV3/background.js" ]; then
    say 构建 "缺产物（跑 env-up 重建）"
  elif [ -n "$(find src entrypoints -name '*.ts' -newer "$MV3/background.js" 2>/dev/null | head -1)" ]; then
    say 构建 "源码较产物新（跑 env-up 重建）"
  else
    say 构建 "产物最新"
  fi
  RELAY_PID=$(listener_pid)
  if [ -n "$RELAY_PID" ]; then
    if relay_is_stale "$RELAY_PID"; then
      say 中继 "在跑（PID ${RELAY_PID}）但是**旧代码**：跑 env-up 自动换新（--status 只读，不动它）"
    else
      say 中继 "在跑（PID ${RELAY_PID}），健康且代码是最新的"
    fi
  else
    say 中继 "没在跑（跑 env-up 起）"
  fi
  BROWSER_MAIN=$(browser_main_pid)
  if [ -n "$BROWSER_MAIN" ]; then
    BROWSER_STARTED=$(proc_started "$BROWSER_MAIN")
    BUILD_MTIME=$("${MTIME[@]}" "$MV3/background.js" 2>/dev/null || echo 0)
    if ! browser_loaded_extension "$BROWSER_MAIN"; then
      say 浏览器 "在跑（PID ${BROWSER_MAIN}）却没带 --load-extension——扩展没装进来，跑 env-up 换"
    elif [ -n "$BROWSER_STARTED" ] && [ "$BUILD_MTIME" -gt "$BROWSER_STARTED" ]; then
      say 浏览器 "在跑（PID ${BROWSER_MAIN}），但装的扩展比构建旧——跑 env-up 换"
    else
      say 浏览器 "在跑（PID ${BROWSER_MAIN}），扩展是新的"
    fi
  else
    say 浏览器 "没在跑（跑 env-up 起）"
  fi
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$DEBUG_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    say 调试口 "在（${DEBUG_PORT}）：可跑 scripts/page-action.py"
  else
    say 调试口 "关（要探针就 scripts/env-up.sh --debug）"
  fi
  age=$(last_probe_age)
  if [ "$age" = "-1" ]; then
    say 探活 "读不到（中继可能不是本脚本起的、日志在别处）"
  elif [ "$age" = "-2" ]; then
    say 探活 "日志在但没有痕迹：扩展没探活（总开关关着是常态），或中继跑旧代码（不记 ping）"
  elif [ "$age" -gt 90 ]; then
    say 探活 "${age}s 前没探活：总开关关着 / SW 死了 / 浏览器关了（关着是常态）"
  else
    say 探活 "新鲜（${age}s 前）：扩展活着且总开关开着"
  fi
  exit 0
fi

# ---- 0) 工具：缺哪样报哪样（缺 pnpm/node 会一路以奇怪的方式红，早报早省事）----
missing=()
for tool in pnpm node curl uv python3; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  say 工具 "缺 ${missing[*]} —— 装齐再跑"
  exit 1
fi

# ---- 1) 扩展构建：源码比产物新才重建（老产物 = 协议说明旧、名册缺动作）----
if [ ! -f "$MV3/background.js" ]; then
  pnpm build >/tmp/dsb-build.log 2>&1 && say 构建 "缺产物，已重建" || { say 构建 "重建失败 → /tmp/dsb-build.log"; exit 1; }
elif [ -n "$(find src entrypoints -name '*.ts' -newer "$MV3/background.js" 2>/dev/null | head -1)" ]; then
  pnpm build >/tmp/dsb-build.log 2>&1 && say 构建 "源码较新，已重建" || { say 构建 "重建失败 → /tmp/dsb-build.log"; exit 1; }
else
  say 构建 "产物最新"
fi

# ---- 2) 中继 ----
# 自检走 initialize（不记日志）：dsb 记 ping，ping 日志即纯扩展信号。
RELAY_JUST_STARTED=0
if rpc '{"jsonrpc":"2.0","id":"env-up","method":"initialize"}' | grep -q '"result"'; then
  # **已在跑但可能是旧代码 → 自动换新**（2026-10-05 用户定：「起环境必须都对应最新」）。
  # 之前只提示、要人手动 kill，那是把纪律外包给记性——浏览器那条早就自动重启了，
  # 两条路不一致就等于永远有一半环境跑着旧代码。代价只是丢子进程（mcp.json 里
  # 起着的 server 要重拉一遍），换来「跑的一定是当前代码」。
  RELAY_PID=$(listener_pid)
  if relay_is_stale "$RELAY_PID"; then
    say 提示 "dsb 源码比中继进程新（PID ${RELAY_PID}）——跑的是旧代码：自动重启中继"
    stop_relay "$RELAY_PID"
    start_relay
    RELAY_JUST_STARTED=1
    say 中继 "已重启 → /tmp/dsb-relay.log（旧代码换新，会丢它起的子进程）"
  else
    say 中继 "已在跑（PID ${RELAY_PID}），代码是最新的"
  fi
else
  # initialize 不回话但端口有人占着 = 跑着旧代码的长驻中继。同样自动换新。
  RELAY_PID=$(listener_pid)
  if [ -n "$RELAY_PID" ]; then
    say 提示 "中继在跑（PID ${RELAY_PID}）却不答 initialize：跑的是旧代码，自动重启它"
    stop_relay "$RELAY_PID"
    start_relay
    RELAY_JUST_STARTED=1
    say 中继 "已重启 → /tmp/dsb-relay.log（旧代码换新，会丢它起的子进程）"
  else
    start_relay
    RELAY_JUST_STARTED=1
    say 中继 "已起 → /tmp/dsb-relay.log"
  fi
fi

# ---- 3) 浏览器：只认独立 profile；装的扩展比构建旧就自动重启 ----
# 主进程的首个 flag 是 --user-data-dir，子进程是 --type=，据此只数主进程。
STARTED_BROWSER=0
BROWSER_MAIN=$(browser_main_pid)
if [ -n "$BROWSER_MAIN" ]; then
  # 装的扩展比构建旧 = 跑的旧代码（SW 脚本缓存在 profile 里，重启
  # 浏览器才会换新）。重启只动 ds-browser 这一个进程：登录态在
  # profile 里不丢，开着的标签页会关；用户的别的浏览器一律不碰。
  BROWSER_STARTED=$(proc_started "$BROWSER_MAIN")
  BUILD_MTIME=$("${MTIME[@]}" "$MV3/background.js" 2>/dev/null || echo 0)
  STALE=0
  if [ -n "$BROWSER_STARTED" ] && [ "$BUILD_MTIME" -gt "$BROWSER_STARTED" ]; then STALE=1; fi
  NO_EXT=0
  if ! browser_loaded_extension "$BROWSER_MAIN"; then NO_EXT=1; fi
  NEED_DEBUG=0
  if [ "$DEBUG" = 1 ]; then
    case "$(ps -o command= -p "$BROWSER_MAIN" 2>/dev/null)" in
      *--remote-debugging-port=*) : ;;
      *) NEED_DEBUG=1 ;;
    esac
  fi
  if [ "$NO_EXT" = 1 ] || [ "$STALE" = 1 ] || [ "$NEED_DEBUG" = 1 ]; then
    if [ "$NO_EXT" = 1 ]; then
      say 提示 "ds-browser 在跑却没带 --load-extension（扩展没装进来）：自动重启它"
    elif [ "$STALE" = 1 ]; then
      say 提示 "浏览器装的扩展比构建旧（跑旧代码）：自动重启 ds-browser"
    else
      say 提示 "浏览器没带调试口：按 --debug 重启 ds-browser"
    fi
    kill_browser "$BROWSER_MAIN"
    start_browser
  else
    say 浏览器 "已在跑（独立 profile，扩展是新的）"
  fi
else
  start_browser
fi

# ---- 4) 判据 ----
# 扩展不再有外露的探针面（POST /action 与动作流随 ADR-0007 一起废了）：
# 本机这半直接验；扩展那一半靠 ping 日志（判据 4）+ 末尾的图标与控制台。
# 等中继把口张开：配了 MCP server 时网关是**先把子进程拉起来、再 bind** 的，冷启动
# （npx 首次下载）实测要三十几秒——固定 sleep 3 会把「还在起」判成「不健康」。
# 自检照样用 initialize（不记日志）：ping 日志是纯扩展信号，别拿自检污染它。
hello_out=""
for _ in $(seq 1 60); do
  hello_out=$(rpc '{"jsonrpc":"2.0","id":"env-up","method":"initialize"}')
  case "$hello_out" in *'"result"'*) break ;; esac
  sleep 1
done
case "$hello_out" in
  *'"result"'*) say 判据1 "中继健康（initialize 回话）" ;;
  *) say 判据1 "中继不健康：$hello_out" ; exit 1 ;;
esac

list_out=$(rpc '{"jsonrpc":"2.0","id":"env-up","method":"tools/list"}')
tools=$(printf '%s' "$list_out" | python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except ValueError:
    print("")
    raise SystemExit
tools = payload.get("result", {}).get("tools")
if isinstance(tools, list):
    print(" ".join(t.get("name", "?") for t in tools))')
if [ -n "$tools" ]; then
  say 判据2 "工具表取得到：$tools"
else
  say 判据2 "工具表取不到 / 是空的：$list_out"
  say 判据2 "空 = mcp.json 没配 server（只剩自家 said_*）；取不到 = 网关有毛病 → /tmp/dsb-relay.log"
fi

if [ "$STARTED_BROWSER" = 1 ]; then
  # 会话页已随浏览器启动打开（首个标签页），这里不再另起一次 Chromium——
  # 那只会再开一个标签页。这里只报一句。
  say 判据3 "会话页随浏览器启动已开（首个标签页即 chat.deepseek.com，无空白新标签页）"
else
  say 判据3 "浏览器是先起的：有没有会话标签页这里问不到（扩展没有外露探针面）"
  if [ "$UNAME_S" = "Darwin" ]; then
    say 判据3 "要开一个就：open -a Chromium 'https://chat.deepseek.com/'"
  else
    say 判据3 "要开一个就：$CHROME --user-data-dir=\"$PROFILE\" 'https://chat.deepseek.com/'"
  fi
fi
if [ "$DEBUG" = 1 ]; then
  say 判据3 "调试口 ${DEBUG_PORT}：探针 scripts/page-action.py read / send <动作> / stop-test"
fi

# 测试环境的已知起点：深度思考、智能搜索都关着（幂等；写作框不在——没登录 / 被禁言——
# 就只报、不硬点，也不让 env-up 因此失败）。
if [ "$DEBUG" = 1 ]; then
  if command -v uv >/dev/null 2>&1; then
    if toggles_out=$(uv run scripts/page-action.py toggles-off 2>&1); then
      say 开关 "测试环境：深度思考、智能搜索已关"
    else
      say 开关 "没能确认两个开关都关着（登录后重跑，或手动 scripts/page-action.py toggles-off）"
    fi
    printf '%s\n' "$toggles_out" | sed 's/^/        /'
  fi
fi

# 判据 4：扩展最后探活（信息项，不阻塞——总开关关着是常态）。
age=$(last_probe_age)
if [ "$age" = "-1" ]; then
  say 判据4 "扩展探活读不到（中继可能不是本脚本起的、日志在别处）"
elif [ "$age" = "-2" ]; then
  say 提示 "探活日志在但没有痕迹：扩展没探活（总开关关着是常态），或中继跑旧代码（不记 ping）"
elif [ "$age" -gt 90 ]; then
  say 提示 "扩展 ${age}s 没探活：总开关关着 / SW 死了 / 浏览器关了（关着是常态，不算故障）"
  if [ "$RELAY_JUST_STARTED" = 1 ]; then
    say 提示 "中继是本脚本刚起的：下一轮探活最多 30s 后到"
  fi
else
  say 判据4 "扩展探活新鲜（${age}s 前）：扩展活着且总开关开着"
fi

cat <<EOF

  扩展那一半：判据 4 已自动报最后探活距今；细粒度看这三处：
    1. 图标三态：关 / 绿(可达) / 红(带原因与 uv run dsb 启动命令)；转框 = 调用在途
    2. 悬停：总开关、账号处境、上次故障（时刻·环节·原因）都在标题里
    3. 页面控制台 [ds-] 开头的行：认出围栏、协议说明注入、回灌发没发出去

  人做的（只第一次，之后永久生效）：
    登录 DeepSeek 与勾「代你发言」(选项页那个复选框,旧文案叫"替人开口")都在**独立 profile** 这个窗口里做（跟主浏览器
    两套登录态）。勾「代你发言」那一步故意没有动作口（agent 不能自授发言权，
    围栏别拆）；不勾则 composer.type / send.* 回 disabled，属预期不是故障。

  工具栏上找不到 ds- 图标时：先点地址栏右边那个**拼图图标**（扩展菜单）——命令行
  装的扩展不自动钉在工具栏上，在拼图里点一下「固定」它就出来了。拼图里也没有，
  就说明这个窗口不是 ds-browser（或起来时没带 --load-extension）：关掉它重跑本脚本。

  查某动作为什么失败，两步就够：
    1. page.state 的 account 说清处境 —— muted(带解封时刻) / signed-out / unknown
    2. 失败码本身就说清是哪一步 —— composer-absent(没有写作框) / page-changed
       (页面上找不到认得的东西) / read-failed(读不完) / tab-gone(这一跳走不通)

  账号被禁言时（站点橙框「禁言至 …」，写作框不渲染）整条交流线是断的：
  那是账号在站点的处罚，不是扩展坏了。别去修选择器，那修不好；等解封。

  本脚本幂等；重跑只会重启「装的扩展比构建旧」的 ds-browser
  （独立 profile，登录态不丢），不动任何别的浏览器。
EOF
