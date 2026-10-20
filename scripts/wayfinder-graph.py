#!/usr/bin/env python3
"""从 CSV 生成 `docs/wayfinder/current-functionality.md` 里的全依赖图.

**为什么要有它**: 依赖边是数据, 画成 Mermaid 只是其中一种看法. 手改 Mermaid 和 CSV
两份一定会漂 -- 改了一边忘了另一边, 图上看起来正常, 实际已经少了半条边. 这里把
`nodes.csv` / `edges.csv` 当源, 图由脚本生成; `--check` 接进 pre-commit 与 CI, 两边
不一致当场红.

**它读什么**:

- `docs/wayfinder/nodes.csv`: `id,label,kind,parent,status`
  - `kind=domain`: 域, `parent` 为空;
  - `kind=group`: 动作组, `parent` 指向域 (当前是 D3);
  - `kind=action`: 动作, `parent` 指向组; 动作名与 `src/lib/registry.ts` 逐一对拍;
  - `status`: `clicked` / `unclicked` / `read` / `background`, 只给 action.
- `docs/wayfinder/edges.csv`: `from,to,kind,note,render`
  - `render=graph` 进图, `domain` / `ownership` / `call` / `order` 画实线,
    `probe` / `evidence` 画虚线;
  - `render=detail` 是逐动作边 (`order` / `readback`), 只作数据, 不画进组图;
  - `note` 是给人看的, 不进图.

**用法**:

    uv run scripts/wayfinder-graph.py           # 重新生成文档里的图
    uv run scripts/wayfinder-graph.py --check   # 只核对, 有出入退出码 1

图只替换 `<!-- wayfinder:graph:start -->` 与 `<!-- wayfinder:graph:end -->` 之间的块;
其余文字与表不动. 动作在 CSV 里是独立行, 图里收进组节点, 避免 40 多个节点糊成一团;
逐动作的先后仍看文档里的动作边表.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

TAG = "[wayfinder-graph]"
ROOT = Path(__file__).resolve().parents[1]
WAYFINDER = ROOT / "docs" / "wayfinder"
NODES = WAYFINDER / "nodes.csv"
EDGES = WAYFINDER / "edges.csv"
DOC = WAYFINDER / "current-functionality.md"
REGISTRY = ROOT / "src" / "lib" / "registry.ts"
START = "<!-- wayfinder:graph:start -->"
END = "<!-- wayfinder:graph:end -->"

NODE_COLUMNS = {"id", "label", "kind", "parent", "status"}
EDGE_COLUMNS = {"from", "to", "kind", "note", "render"}
NODE_KINDS = {"domain", "group", "action"}
EDGE_KINDS = {"domain", "ownership", "call", "order", "probe", "evidence", "readback"}
RENDERS = {"graph", "detail"}
DOTTED = {"probe", "evidence"}
STATUS = {"clicked": "点", "unclicked": "未点", "read": "读", "background": "后台"}
SAFE_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ACTION_ID = re.compile(r"^[a-z][a-z0-9_.]*$")
ACTION_ROW = re.compile(r'^  "([a-z][a-z0-9_.]*)"\s*:\s*\{', re.M)


class BadCSV(Exception):
    """CSV 读不懂或形状不对; 报出来比生成一张看起来正常的图好."""


def read_rows(path: Path, columns: set[str]) -> list[dict[str, str]]:
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None or set(reader.fieldnames) != columns:
                raise BadCSV(
                    f"{path} 表头不对: 需要 {sorted(columns)}, 读到 {reader.fieldnames or '空'}"
                )
            rows = []
            for raw in reader:
                row = {key: (value or "").strip() for key, value in raw.items() if key is not None}
                if any(row.values()):
                    rows.append(row)
            return rows
    except OSError as exc:
        raise BadCSV(f"读不了 {path}: {exc}") from exc


def load_nodes() -> list[dict[str, str]]:
    rows = read_rows(NODES, NODE_COLUMNS)
    if not rows:
        raise BadCSV(f"{NODES} 是空的")
    by_id: dict[str, dict[str, str]] = {}
    for row in rows:
        node_id = row["id"]
        if not node_id:
            raise BadCSV("nodes.csv 有空的 id")
        if node_id in by_id:
            raise BadCSV(f"nodes.csv 的 id 重复: {node_id}")
        if row["kind"] not in NODE_KINDS:
            raise BadCSV(f"{node_id}: kind={row['kind']!r} 不在 {sorted(NODE_KINDS)}")
        if row["kind"] in {"domain", "group"} and not SAFE_ID.match(node_id):
            raise BadCSV(f"{node_id}: 域/组的 id 只能用字母数字下划线")
        if row["kind"] == "action" and not ACTION_ID.match(node_id):
            raise BadCSV(f"{node_id}: 动作名形状不对")
        by_id[node_id] = row

    for node in rows:
        kind, parent = node["kind"], node["parent"]
        if kind == "domain":
            if parent:
                raise BadCSV(f"{node['id']}: domain 不该有 parent")
            if not node["label"]:
                raise BadCSV(f"{node['id']}: domain 缺 label")
            if node["status"]:
                raise BadCSV(f"{node['id']}: domain 不该有 status")
        elif kind == "group":
            if parent not in by_id or by_id[parent]["kind"] != "domain":
                raise BadCSV(f"{node['id']}: group 的 parent 必须是域, 读到 {parent!r}")
            if not node["label"]:
                raise BadCSV(f"{node['id']}: group 缺 label")
            if node["status"]:
                raise BadCSV(f"{node['id']}: group 不该有 status")
        else:
            if parent not in by_id or by_id[parent]["kind"] != "group":
                raise BadCSV(f"{node['id']}: action 的 parent 必须是组, 读到 {parent!r}")
            if node["status"] not in STATUS:
                raise BadCSV(f"{node['id']}: status={node['status']!r} 不在 {sorted(STATUS)}")
    return rows


def load_edges(nodes: list[dict[str, str]]) -> list[dict[str, str]]:
    rows = read_rows(EDGES, EDGE_COLUMNS)
    by_id = {node["id"]: node for node in nodes}
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        source, target, kind, render = row["from"], row["to"], row["kind"], row["render"]
        if kind not in EDGE_KINDS:
            raise BadCSV(f"{source}->{target}: kind={kind!r} 不在 {sorted(EDGE_KINDS)}")
        if render not in RENDERS:
            raise BadCSV(f"{source}->{target}: render={render!r} 不在 {sorted(RENDERS)}")
        if source not in by_id or target not in by_id:
            raise BadCSV(f"{source}->{target}: 端点不在 nodes.csv 里")
        if source == target:
            raise BadCSV(f"{source}->{target}: 自环没有意义")
        key = (source, target, kind)
        if key in seen:
            raise BadCSV(f"{source}->{target} ({kind}) 重复")
        seen.add(key)
        source_kind, target_kind = by_id[source]["kind"], by_id[target]["kind"]
        if kind == "domain" and (source_kind != "domain" or target_kind != "domain"):
            raise BadCSV(f"{source}->{target}: domain 边只能连域")
        if kind == "evidence" and (source_kind != "domain" or target_kind != "domain"):
            raise BadCSV(f"{source}->{target}: evidence 边只能连域")
        if kind in {"ownership", "call"} and (
            render != "graph" or source_kind != "domain" or target_kind != "group"
        ):
            raise BadCSV(f"{source}->{target}: {kind} 边只能从域到组, 且只进图")
        if kind == "probe" and (
            render != "graph" or source_kind != "group" or target_kind != "group"
        ):
            raise BadCSV(f"{source}->{target}: probe 边只能从组到组, 且只进图")
        if kind == "order":
            if render == "graph" and (source_kind != "group" or target_kind != "group"):
                raise BadCSV(f"{source}->{target}: 图上的 order 边只能从组到组")
            if render == "detail" and (source_kind != "action" or target_kind != "action"):
                raise BadCSV(f"{source}->{target}: 细则 order 边只能从动作到动作")
        if kind == "readback" and (
            render != "detail" or source_kind != "action" or target_kind != "action"
        ):
            raise BadCSV(f"{source}->{target}: readback 边只能是细则的动作到动作")
    if not rows:
        raise BadCSV(f"{EDGES} 是空的")
    return rows


def registry_actions() -> set[str]:
    try:
        text = REGISTRY.read_text(encoding="utf-8")
    except OSError as exc:
        raise BadCSV(f"读不了 {REGISTRY}: {exc}") from exc
    names = set(ACTION_ROW.findall(text))
    if not names:
        raise BadCSV(f"{REGISTRY} 里一个动作名都没读到")
    return names


def check_action_roster(nodes: list[dict[str, str]]) -> None:
    expected = registry_actions()
    actual = {node["id"] for node in nodes if node["kind"] == "action"}
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing or extra:
        raise BadCSV(
            f"nodes.csv 的动作与 registry.ts 不一致: 缺 {missing or '无'}, 多 {extra or '无'}"
        )


def marker(status: str) -> str:
    return f" [{STATUS[status]}]"


def render(nodes: list[dict[str, str]], edges: list[dict[str, str]]) -> str:
    children: dict[str, list[dict[str, str]]] = defaultdict(list)
    for node in nodes:
        if node["kind"] == "action":
            children[node["parent"]].append(node)

    lines = ["flowchart TB"]
    for node in nodes:
        if node["kind"] not in {"domain", "group"}:
            continue
        label = node["label"]
        if node["kind"] == "group":
            for child in children[node["id"]]:
                label += f"<br/>{child['label'] or child['id']}{marker(child['status'])}"
        lines.append(f"  {node['id']}[{json.dumps(label, ensure_ascii=False)}]")

    lines.append("")
    for edge in edges:
        if edge["render"] != "graph":
            continue
        arrow = "-.->" if edge["kind"] in DOTTED else "-->"
        lines.append(f"  {edge['from']} {arrow} {edge['to']}")
    return "```mermaid\n" + "\n".join(lines) + "\n```"


def splice(text: str, block: str) -> str:
    if text.count(START) != 1 or text.count(END) != 1:
        raise BadCSV(f"{DOC} 里要各有一个 {START} / {END}")
    start = text.index(START) + len(START)
    end = text.index(END, start)
    # Prettier 会在 HTML 注释里的围栏代码块前后各留一个空行; 生成物也照这个形状,
    # 否则 lint-staged 一跑, `--check` 就会把纯排版差报成漂移.
    return text[:start].rstrip("\n") + "\n\n" + block + "\n\n" + text[end:]


def counts(nodes: list[dict[str, str]], edges: list[dict[str, str]]) -> str:
    domains = sum(node["kind"] == "domain" for node in nodes)
    groups = sum(node["kind"] == "group" for node in nodes)
    actions = sum(node["kind"] == "action" for node in nodes)
    graph = sum(edge["render"] == "graph" for edge in edges)
    detail = sum(edge["render"] == "detail" for edge in edges)
    return f"{domains} 域 / {groups} 组 / {actions} 动作 / {graph} 图边 / {detail} 细则边"


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--check", action="store_true", help="只核对, 不写回; 有出入退出码 1")
    args = parser.parse_args()

    try:
        nodes = load_nodes()
        edges = load_edges(nodes)
        check_action_roster(nodes)
        if not DOC.exists():
            raise BadCSV(f"缺 {DOC}")
        current = DOC.read_text(encoding="utf-8")
        wanted = splice(current, render(nodes, edges))
    except BadCSV as exc:
        print(f"{TAG} {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    summary = counts(nodes, edges)
    if args.check:
        if current != wanted:
            print(f"{TAG} 图与 CSV 不一致 ({summary}).", file=sys.stderr)
            print(f"{TAG} 跑 `uv run scripts/wayfinder-graph.py` 重新生成.", file=sys.stderr)
            raise SystemExit(1)
        print(f"{TAG} 一致: {summary}.")
        return

    DOC.write_text(wanted, encoding="utf-8")
    print(f"{TAG} 写好 {DOC.relative_to(ROOT).as_posix()} ({summary}).")


if __name__ == "__main__":
    main()
