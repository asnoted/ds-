"""对拍: `audit-issues.py` 那条信息级检查的口径(票正文里的 ADR 引用).

它不判失败(信息级), 所以更不能量错: 报多了是噪音, 报少了等于没报 -- 2026-10-17 那次
重编号之后, 关着的票里留的旧号就是靠它才能看见的.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "audit-issues.py"


def load_audit() -> ModuleType:
    spec = importlib.util.spec_from_file_location("audit_issues_under_test", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ghost(number: str) -> str:
    """拼出来的悬空号: 本仓的引用守卫(ADR-0001 决定 4)扫的是字面 `ADR-NNNN`, 写全了
    这条测试自己就会把它报出来 -- 它是对的, 所以这里把字面拆开."""
    return "ADR-" + number


def ticket(number: int, body: str, title: str = "一张票") -> dict:
    return {"number": number, "title": title, "body": body}


def test_only_the_numbers_outside_the_corpus_are_reported() -> None:
    module = load_audit()
    issues = [
        ticket(1, "这条按 ADR-0010 办."),
        ticket(2, f"旧号: {ghost('0023')} 与 {ghost('0030')}."),
        ticket(3, "没有引用."),
    ]
    found = module.check_citations(issues, {"0002", "0010"})
    assert len(found) == 1
    assert "#2" in found[0]
    assert ghost("0023") in found[0] and ghost("0030") in found[0]
    assert "#1" not in found[0]


def test_the_second_number_of_a_paired_citation_counts() -> None:
    """并列写法 `ADR-0007/0006` 里的第二个号也要查 -- 上一轮漏的正是这种半边."""
    module = load_audit()
    found = module.check_citations([ticket(9, f"见 ADR-0007/{ghost('0006')}")], {"0007"})
    assert len(found) == 1
    assert ghost("0006") in found[0]


def test_a_space_instead_of_the_hyphen_also_counts() -> None:
    module = load_audit()
    found = module.check_citations([ticket(9, f"见 {'ADR ' + '0099'}")], {"0002"})
    assert len(found) == 1
    assert ghost("0099") in found[0]


def test_an_empty_or_missing_body_is_not_a_problem() -> None:
    module = load_audit()
    assert module.check_citations([ticket(5, ""), {"number": 6, "title": "无正文"}], {"0002"}) == []


def test_the_corpus_numbers_come_from_the_adr_directory() -> None:
    """数的是 `docs/adr/NNNN-*.md` 的文件名头四位, 且不含生成的 `README.md`."""
    module = load_audit()
    numbers = module.current_adr_numbers()
    assert "0001" in numbers
    assert all(len(num) == 4 and num.isdigit() for num in numbers)
    # 与守卫(骨架那条)读的是同一批文件: 少读一篇这里就会多报一片假情报.
    on_disk = {
        path.stem[:4] for path in (ROOT / "docs" / "adr").glob("*.md") if path.name != "README.md"
    }
    assert numbers == on_disk


def test_the_role_table_matches_the_tracker_doc() -> None:
    """五张角色的**本仓名字**写死在 `docs/agents/triage-labels.md` 那张表的右列, 脚本得跟它一致.

    左列是 Matt 技能的说法, 右列才是本仓的标签; 对不上时脚本会拿一个不存在的标签去查
    (查不漏也报不出), 而这**不会**让任何东西变红 -- 所以在这儿钉住.
    """
    module = load_audit()
    doc = (ROOT / "docs" / "agents" / "triage-labels.md").read_text(encoding="utf-8")
    rows = [line.split("|") for line in doc.splitlines() if line.startswith("| `")]
    in_doc = {cells[2].strip().strip("`") for cells in rows}
    assert in_doc, "那张表怎么一行都没解析出来?"
    assert in_doc == set(module.ROLES)
