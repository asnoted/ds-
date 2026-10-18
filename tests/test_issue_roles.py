"""issue 角色标签那几条账目判据的纯半边: 开票要恰好一个角色, 关票不许留"在等".

这几条**只报不判**(信息级), 所以量错了没人知道: 报多了是噪音, 报少了等于没报 --
而它们背后每一条都有一次真实的乱象(见模块注释). 这里把"报什么 / **不报什么**"钉住,
尤其是不报的那几样 -- 那些是判据的边界, 最容易被后来的人"顺手补齐"。

搬家中间态: 模块在 `devtools/dsbcli/tools/` 与 `scripts/` 之间搬, 两种树都要能跑, 所以
`load_audit` 先按包找, 再按老路径兜底; 搬完把兜底那半删掉。
"""

from __future__ import annotations

import importlib
import importlib.util
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

LEGACY = ROOT / "scripts" / "audit-issues.py"


def load_audit() -> ModuleType:
    try:
        return importlib.import_module("dsbcli.tools.audit_issues")
    except ModuleNotFoundError:
        if not LEGACY.is_file():
            raise
        spec = importlib.util.spec_from_file_location("audit_issues_legacy", LEGACY)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module


def ticket(
    number: int,
    *,
    state: str = "OPEN",
    labels: tuple[str, ...] = (),
    title: str = "一张票",
    body: str = "正文",
    created_days_ago: int | None = None,
) -> dict[str, Any]:
    issue: dict[str, Any] = {
        "number": number,
        "state": state,
        "title": title,
        "body": body,
        "labels": [{"name": name} for name in labels],
    }
    if created_days_ago is not None:
        opened = datetime.now(UTC) - timedelta(days=created_days_ago)
        issue["createdAt"] = opened.isoformat().replace("+00:00", "Z")
    return issue


def numbers(lines: list[str]) -> list[int]:
    """报表行里的 `#N` 抽出来 -- 比整句好读, 也不把措辞钉死."""
    return [int(found.group(1)) for line in lines if (found := re.search(r"#(\d+)", line))]


def test_only_our_five_roles_count_as_roles() -> None:
    """类型标签(`bug`)与别的标签都不是角色: 只挂类型标签的开票照样是"没 triage"."""
    audit = load_audit()
    assert audit.roles_of(ticket(1, labels=("bug", "enhancement"))) == []
    assert audit.roles_of(ticket(2, labels=("bug", "needs-triage"))) == ["needs-triage"]


def test_an_open_ticket_without_a_role_is_reported() -> None:
    audit = load_audit()
    issues = [
        ticket(1, labels=("bug",)),
        ticket(2, labels=("needs-triage",)),
        ticket(3, state="CLOSED"),
    ]
    assert numbers(audit.check_open_without_role(issues)) == [1]


def test_two_roles_on_one_open_ticket_is_a_contradiction() -> None:
    audit = load_audit()
    issues = [
        ticket(1, labels=("wontfix", "ready-for-agent")),
        ticket(2, labels=("ready-for-agent", "bug")),
        ticket(3, state="CLOSED", labels=("wontfix", "ready-for-agent")),
    ]
    assert numbers(audit.check_open_with_many_roles(issues)) == [1]


def test_a_closed_ticket_keeps_its_history_roles() -> None:
    """关票上的 `ready-for-*` 与 `wontfix` 记着当初怎么派出去 / 为什么没做, 摘不得也就不许报;
    "在等"那两类 (`needs-triage` / `needs-info`) 关了就成假话, 必须报."""
    audit = load_audit()
    issues = [
        ticket(1, state="CLOSED", labels=("ready-for-agent",)),
        ticket(2, state="CLOSED", labels=("wontfix",)),
        ticket(3, state="CLOSED", labels=("needs-info",)),
        ticket(4, state="CLOSED", labels=("needs-triage", "wontfix")),
        ticket(5, labels=("needs-info",)),
    ]
    assert numbers(audit.check_closed_waiting(issues)) == [3, 4]


def test_wontfix_and_ready_are_mutually_exclusive_in_any_state() -> None:
    audit = load_audit()
    issues = [
        ticket(1, labels=("wontfix", "ready-for-human")),
        ticket(2, state="CLOSED", labels=("wontfix", "ready-for-agent")),
        ticket(3, labels=("wontfix", "needs-info")),
        ticket(4, labels=("wontfix",)),
    ]
    assert numbers(audit.check_dispatch_conflict(issues)) == [1, 2]


def test_unlabeled_only_nags_open_tickets() -> None:
    """开着的票零标签会在按标签过滤的队列里隐形; 关掉的是历史, 逼它补一个就是编造."""
    audit = load_audit()
    issues = [
        ticket(1),
        ticket(2, state="CLOSED"),
        ticket(3, labels=("bug",)),
        ticket(4, state="CLOSED", labels=("needs-info",)),
    ]
    assert numbers(audit.check_unlabeled(issues)) == [1]


def test_a_zombie_needs_needs_info_an_empty_body_and_no_comments() -> None:
    audit = load_audit()
    zombie = ticket(1, labels=("needs-info",), body="", created_days_ago=30)
    answered = ticket(2, labels=("needs-info",), body="", created_days_ago=30)
    answered["comments"] = [{"body": "有人回过一句"}]
    fresh = ticket(3, labels=("needs-info",), body="", created_days_ago=1)
    with_body = ticket(4, labels=("needs-info",), body="写了要补什么", created_days_ago=30)
    other_role = ticket(5, labels=("needs-triage",), body="", created_days_ago=30)
    issues = [zombie, answered, fresh, with_body, other_role]
    assert numbers(audit.check_zombies(issues, 7)) == [1]
    assert numbers(audit.check_zombies(issues, 0)) == [1, 3]
