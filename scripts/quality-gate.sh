#!/usr/bin/env bash
# 质量入口:先报"被测的是哪个提交",再跑 pnpm quality:ci.
#
# 为什么要有它: 本仓 jj 与 git 双视图, 工作副本落后于 bookmark ref 时,
# 质量门跑的是旧检出 -- 数目报出来是对的, 对应的代码是错的(spec #96 的
# retro 候选 1: 同一个坑咬过两次). 所以数目必须和提交号一起报, 对不上一眼可见.
#
# 用法: scripts/quality-gate.sh          # 报提交 + pnpm quality:ci
#       scripts/quality-gate.sh --quiet  # 只报提交, 不跑质量门(脚本自查用)
#
# jj 不存在(比如 CI 容器)就只报 git HEAD, 不算失败.

set -euo pipefail

cd "$(dirname "$0")/.."

git_head=$(git rev-parse --short HEAD 2>/dev/null || echo "no-git")
jj_id="jj 不在"
if command -v jj >/dev/null 2>&1; then
  jj_id=$(jj log -r @ --no-graph -T 'commit_id.short()' 2>/dev/null || echo "jj 看不见 @")
fi

echo "[quality-gate] git HEAD: $git_head | jj @: $jj_id"

if [[ "${1:-}" != "--quiet" ]]; then
  pnpm quality:ci
fi
