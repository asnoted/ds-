"""无人值守驱动的判定半边: 闲的判读, "催过就不再催"的基线, 以及一拍扫炸了怎么办.

起真进程轮询那一半不在测试范围; 判据全在 `should_nudge` / `view_of` /
`Follower.tick` / `watch` 这四处, 它们错了不会报错, 只会让会话被灌消息,
或者一直没人推 -- 两种都只能靠用例盯住.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "unattended.py"


def load_driver() -> ModuleType:
    spec = importlib.util.spec_from_file_location("unattended_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeClient:
    """喂读数: 每次 prompt 把会话的 `updated` 推到那条消息上, 与真服务同形."""

    def __init__(self) -> None:
        self.running: set[str] = set()
        self.infos: dict[str, dict] = {}
        self.sent: list[tuple[str, str]] = []

    def add(self, session_id: str, updated: float = 1000.0) -> None:
        self.infos[session_id] = {"time": {"created": updated - 1, "updated": updated}}

    def touch(self, session_id: str, updated: float) -> None:
        self.infos[session_id]["time"]["updated"] = updated

    def active(self) -> set[str]:
        return set(self.running)

    def info(self, session_id: str) -> dict | None:
        return self.infos.get(session_id)

    def prompt(self, session_id: str, text: str) -> float:
        self.sent.append((session_id, text))
        created = self.infos[session_id]["time"]["updated"] + 1
        self.infos[session_id]["time"]["updated"] = created
        return created


def follower_of(module: ModuleType, client: FakeClient, sessions: list[str]):
    return module.Follower(client, sessions, "催", out=lambda _line: None)


def test_闲着就催_跑着不催() -> None:
    module = load_driver()
    assert module.should_nudge(module.SessionView("ses_a", False, 1000), None)
    assert not module.should_nudge(module.SessionView("ses_a", True, 1000), None)
    assert not module.should_nudge(module.SessionView("ses_a", True, 2000), 1500)


def test_催过没动过就不再催_动过了才再催() -> None:
    module = load_driver()
    assert not module.should_nudge(module.SessionView("ses_a", False, 1000), 1000)
    assert module.should_nudge(module.SessionView("ses_a", False, 1001), 1000)


def test_落库那条腿_updated越过idle就算还在跑() -> None:
    module = load_driver()
    assert module.still_working({"created": 1, "updated": 200, "idle": 100})
    assert not module.still_working({"created": 1, "updated": 200, "idle": 200})
    assert not module.still_working({"created": 1, "updated": 200})


def test_别的进程推着的会话也认得出在跑() -> None:
    module = load_driver()
    info = {"id": "ses_a", "title": "t", "time": {"updated": 200, "idle": 100}}
    assert "跑着" in module.session_line(info, set())
    assert module.view_of("ses_a", info, set()).running


def test_不在active里但还在跑的不催() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_a", 1000)
    client.infos["ses_a"]["time"]["idle"] = 900
    follower = follower_of(module, client, ["ses_a"])

    assert follower.tick() == 0
    assert client.sent == []


def test_变闲催一次_跑一轮再闲再催() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_a")
    follower = follower_of(module, client, ["ses_a"])

    assert follower.tick() == 1
    assert client.sent == [("ses_a", "催")]
    assert follower.tick() == 0

    client.running.add("ses_a")
    assert follower.tick() == 0

    client.touch("ses_a", 2000)
    client.running.discard("ses_a")
    assert follower.tick() == 1
    assert [text for _sid, text in client.sent] == ["催", "催"]


def test_一拍里只催该催的那几个() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_idle")
    client.add("ses_busy")
    client.running.add("ses_busy")
    follower = follower_of(module, client, ["ses_idle", "ses_busy"])

    assert follower.tick() == 1
    assert client.sent == [("ses_idle", "催")]


def test_dry_run_不发消息也按发过记账() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_a")
    lines: list[str] = []
    follower = module.Follower(client, ["ses_a"], "催", dry_run=True, out=lines.append)

    assert follower.tick() == 1
    assert client.sent == []
    assert follower.tick() == 0
    assert any("dry-run" in line for line in lines)


def test_催过之后仓里没动静就收工不再催() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_a")
    lines: list[str] = []
    follower = module.Follower(client, ["ses_a"], "催", progress=lambda: "same", out=lines.append)

    assert follower.tick() == 1
    client.touch("ses_a", 2000)
    assert follower.tick() == 0
    assert follower.sessions == ()
    assert any("不再盯" in line for line in lines)


def test_仓里有了新动静就继续催() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_a")
    state = {"fingerprint": "a"}
    follower = module.Follower(client, ["ses_a"], "催", progress=lambda: state["fingerprint"])

    assert follower.tick() == 1
    client.touch("ses_a", 2000)
    state["fingerprint"] = "b"
    assert follower.tick() == 1
    assert [text for _sid, text in client.sent] == ["催", "催"]


def test_量不出进度时照旧每轮催() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_a")
    follower = module.Follower(client, ["ses_a"], "催", progress=lambda: None)

    assert follower.tick() == 1
    client.touch("ses_a", 2000)
    assert follower.tick() == 1
    assert len(client.sent) == 2


def test_repo_state_不在git仓里返回None(tmp_path: Path) -> None:
    module = load_driver()
    assert module.repo_state(tmp_path) is None


def test_repo_state_工作树一变指纹就变(tmp_path: Path) -> None:
    module = load_driver()
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    before = module.repo_state(tmp_path)
    assert before is not None
    (tmp_path / "a.txt").write_text("x", encoding="utf-8")
    assert module.repo_state(tmp_path) != before


def test_repo_state_提交后指纹也变(tmp_path: Path) -> None:
    module = load_driver()
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    before = module.repo_state(tmp_path)
    subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path),
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "x",
        ],
        check=True,
    )
    assert module.repo_state(tmp_path) != before


def test_查不到的会话从名单里摘掉() -> None:
    module = load_driver()
    client = FakeClient()
    client.add("ses_a")
    lines: list[str] = []
    follower = module.Follower(client, ["ses_gone", "ses_a"], "催", out=lines.append)

    assert follower.tick() == 1
    assert follower.sessions == ("ses_a",)
    assert any("ses_gone" in line for line in lines)


def test_一拍扫炸了不致命() -> None:
    module = load_driver()
    lines: list[str] = []

    class Flaky:
        def __init__(self) -> None:
            self.sessions = ("ses_a",)
            self.ticks = 0

        def tick(self) -> int:
            self.ticks += 1
            if self.ticks == 1:
                raise module.OpencodeError("第一拍炸了")
            self.sessions = ()
            return 0

    follower = Flaky()
    module.watch(follower, 0.0, out=lines.append)
    assert follower.ticks == 2
    assert any("第一拍炸了" in line for line in lines)


def test_会话查无此人是_None_别的错照抛(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    client = module.OpencodeClient()

    def missing(*_args, **_kwargs):
        return subprocess.CompletedProcess(
            [], 1, '{"_tag":"SessionNotFoundError"}', "HTTP 404 Not Found\n"
        )

    def broken(*_args, **_kwargs):
        return subprocess.CompletedProcess([], 1, "", "HTTP 500 Internal Server Error\n")

    monkeypatch.setattr(subprocess, "run", missing)
    assert client.info("ses_x") is None

    monkeypatch.setattr(subprocess, "run", broken)
    with pytest.raises(module.OpencodeError) as caught:
        client.info("ses_x")
    assert "HTTP 500" in str(caught.value)


def test_prompt_拿服务端那条消息的时刻当基线(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    client = module.OpencodeClient()
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(list(command))
        return subprocess.CompletedProcess(
            command, 0, json.dumps({"data": {"time": {"created": 42}}}), ""
        )

    monkeypatch.setattr(subprocess, "run", run)
    assert client.prompt("ses_x", "催") == 42.0
    assert commands == [
        ["opencode", "api", "post", "/api/session/ses_x/prompt", "--data", '{"text": "\\u50ac"}']
    ]


def test_active_解成会话ID的集合(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    client = module.OpencodeClient()

    def run(command, **_kwargs):
        return subprocess.CompletedProcess(
            command, 0, json.dumps({"data": {"ses_a": {"type": "running"}}}), ""
        )

    monkeypatch.setattr(subprocess, "run", run)
    assert client.active() == {"ses_a"}


def test_拍子给成0直接报错() -> None:
    module = load_driver()
    with pytest.raises(SystemExit):
        module.main(["-s", "ses_a", "--interval", "0"])


def test_列表一行给的是ID_状态_时刻_标题() -> None:
    module = load_driver()
    info = {"id": "ses_a", "title": "制作 opencode 插件", "time": {"updated": 1792316787308}}
    line = module.session_line(info, {"ses_a"})
    assert line.split("  ")[0] == "ses_a"
    assert "跑着" in line
    assert "制作 opencode 插件" in line
    assert "闲着" in module.session_line(info, set())


def test_标题压成一行_长的截断_空的有占位() -> None:
    module = load_driver()
    assert module.flat_title("改名为\n\tdsb") == "改名为 dsb"
    assert module.flat_title(None) == "(没标题)"
    assert module.flat_title("   ") == "(没标题)"
    long = module.flat_title("长" * 100)
    assert len(long) == 40
    assert long.endswith("...")


def test_列会话只要顶层的(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    client = module.OpencodeClient()
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(list(command))
        return subprocess.CompletedProcess(command, 0, json.dumps({"data": []}), "")

    monkeypatch.setattr(subprocess, "run", run)
    assert client.sessions(3) == []
    assert commands[0][-1] == "/api/session?limit=3&parentID=null"


def test_列会话带上认领到的项目(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    client = module.OpencodeClient()
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(list(command))
        return subprocess.CompletedProcess(command, 0, json.dumps({"data": []}), "")

    monkeypatch.setattr(subprocess, "run", run)
    assert client.sessions(3, "proj_1") == []
    assert commands[0][-1] == "/api/session?limit=3&parentID=null&project=proj_1"


def test_cwd_认领项目_取最深的那个祖先() -> None:
    module = load_driver()
    projects = [
        {"id": "outer", "canonical": "/Users/co"},
        {"id": "repo", "canonical": "/Users/co/Downloads/dsb"},
    ]
    assert module.project_at("/Users/co/Downloads/dsb/src/lib", projects) == "repo"
    assert module.project_at("/Users/co/Downloads/dsb", projects) == "repo"
    assert module.project_at("/Users/co/Downloads", projects) == "outer"
    assert module.project_at("/tmp/elsewhere", projects) is None
    assert module.project_at("/Users/co/Downloads/dsb", []) is None


def test_项目表的形状不对就抛(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    client = module.OpencodeClient()

    def run(command, **_kwargs):
        return subprocess.CompletedProcess(command, 0, json.dumps({"oops": True}), "")

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(module.OpencodeError):
        client.projects()


def test_工作目录没了的会话也算够不着(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    client = module.OpencodeClient()

    def run(*_args, **_kwargs):
        return subprocess.CompletedProcess(
            [], 1, '{"_tag":"LocationNotFoundError"}', "HTTP 404 Not Found\n"
        )

    monkeypatch.setattr(subprocess, "run", run)
    assert client.info("ses_x") is None


def test_不给_s_就列会话_不催(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    listed = {"data": [{"id": "ses_a", "title": "t", "time": {"updated": 1000}}]}
    projects = [{"id": "proj_1", "canonical": str(SCRIPT.parents[1])}]

    def run(command, **_kwargs):
        if command[-1].endswith("/project"):
            body = projects
        elif command[-1].endswith("/active"):
            body = {"data": {}}
        else:
            body = listed
        return subprocess.CompletedProcess(command, 0, json.dumps(body), "")

    monkeypatch.setattr(subprocess, "run", run)
    assert module.main([]) == 0


def test_main_把仓进度接上(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_driver()
    seen: dict[str, object] = {}

    class Stub:
        def __init__(self, client, sessions, text, **kwargs):
            seen.update(kwargs)
            self.sessions = tuple(sessions)

    monkeypatch.setattr(module, "Follower", Stub)
    monkeypatch.setattr(module, "OpencodeClient", lambda: object())
    monkeypatch.setattr(module, "watch", lambda *_args, **_kwargs: None)
    assert module.main(["-s", "ses_a"]) == 0
    assert seen["progress"] is module.repo_state
