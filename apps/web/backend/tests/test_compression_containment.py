from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location("compression_containment", ROOT / "apps/web/server/tools/compression/contain.py")
contain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contain)


class SyntheticContainer:
    mechanism = "synthetic-owned-tree"
    def __init__(self, states):
        self.states = iter(states)
        self.closed = False
        self.polls = 0
    def launch(self, command):
        return io.BytesIO(), io.BytesIO()
    def poll(self):
        self.polls += 1
        state = next(self.states)
        if isinstance(state, Exception):
            raise state
        return state
    def close(self):
        self.closed = True


@pytest.mark.parametrize("states, fails", [([None, None, 0], False), ([RuntimeError("resource_limit")], True)])
def test_supervisor_owns_tree_until_all_descendants_exit_and_closes_on_failure(monkeypatch, states, fails):
    owned = SyntheticContainer(states)
    monkeypatch.setattr(contain, "container", lambda *_: owned)
    if fails:
        with pytest.raises(RuntimeError, match="resource_limit"):
            contain.run(["synthetic"], 768, 1024, 1)
    else:
        assert contain.run(["synthetic"], 768, 1024, 1) == 0
        assert owned.polls == 3
    assert owned.closed


def test_probe_cannot_claim_success_when_same_execution_path_fails(monkeypatch):
    owned = SyntheticContainer([RuntimeError("atomic_assignment_failed")])
    monkeypatch.setattr(contain, "container", lambda *_: owned)
    assert contain.probe()["enforced"] is False
    assert owned.closed


def test_disk_monitor_checks_single_candidate_and_combined_attempt(tmp_path):
    (tmp_path / "a").write_bytes(b"a" * 6)
    (tmp_path / "b").write_bytes(b"b" * 6)
    with pytest.raises(RuntimeError, match="resource_limit"):
        contain.check_disk(tmp_path, 10, 10)
    with pytest.raises(RuntimeError, match="resource_limit"):
        contain.check_disk(tmp_path, 5, 20)
    contain.check_disk(tmp_path, 10, 20)


def test_unsupported_platform_does_not_fall_back_to_rlimit(monkeypatch):
    monkeypatch.setattr(contain.sys, "platform", "darwin")
    assert contain.probe()["enforced"] is False


@pytest.mark.parametrize("fails", [False, True])
def test_close_receipt_is_written_only_after_observed_tree_close(monkeypatch, tmp_path, fails):
    owned = SyntheticContainer([0])
    path = tmp_path / "closed.json"
    def close():
        assert not path.exists()
        if fails:
            raise RuntimeError("close_unconfirmed")
        owned.closed = True
    owned.close = close
    monkeypatch.setattr(contain, "container", lambda *_: owned)
    if fails:
        with pytest.raises(RuntimeError, match="close_unconfirmed"):
            contain.run(["synthetic"], 768, 1024, 1, close_file=path, token="a" * 32)
        assert not path.exists()
    else:
        assert contain.run(["synthetic"], 768, 1024, 1, close_file=path, token="a" * 32) == 0
        assert owned.closed
        record = contain.json.loads(path.read_text())
        assert record == {"schema": "compression-close/1", "token": "a" * 32, "pid": contain.os.getpid(), "closed": True}


def test_windows_close_waits_for_owned_job_members_before_closing_handle(monkeypatch):
    events = []
    class Api:
        def state(self, *_):
            events.append("state")
            return None, 0 if events.count("state") >= 3 else 1
        def terminate(self, *_):
            events.append("terminate")
        def close(self, *_):
            events.append("close")
    owned = contain.WindowsContainer.__new__(contain.WindowsContainer)
    owned.api, owned.job, owned.process = Api(), {}, None
    monkeypatch.setattr(contain.time, "sleep", lambda _: None)
    owned.close()
    assert events == ["state", "terminate", "state", "state", "close"]


def test_cooperative_cancellation_closes_tree_and_records_proof(monkeypatch, tmp_path):
    owned = SyntheticContainer([None])
    monkeypatch.setattr(contain, "container", lambda *_: owned)
    path = tmp_path / "closed.json"
    Path(str(path) + ".cancel").write_text("a" * 32)
    with pytest.raises(RuntimeError, match="cancelled"):
        contain.run(["synthetic"], 768, 1024, 1, close_file=path, token="a" * 32)
    assert owned.closed
    assert contain.json.loads(path.read_text())["closed"] is True


def test_windows_reuses_owned_job_and_waits_for_descendants(monkeypatch):
    import types
    calls = []
    class FakeJobs:
        def create(self, name, memory):
            calls.append(("create", memory))
            return {"handle": "owned"}
        def launch_in_job(self, job, command, cwd):
            assert job["handle"] == "owned"
            calls.append(("launch", command))
            return {"stdin": io.BytesIO(), "stdout": io.BytesIO(), "stderr": io.BytesIO()}
        def state(self, job, process):
            return (0, 1) if len(calls) == 2 else (0, 0)
        def memory_exceeded(self, job):
            return False
        def close(self, job, process=None):
            calls.append(("close", job["handle"]))
    monkeypatch.setitem(contain.sys.modules, "windows_job_native", types.SimpleNamespace(NativeWindowsJobs=FakeJobs))
    monkeypatch.setattr(contain.WindowsContainer, "rss", lambda self: 100)
    owned = contain.WindowsContainer(768, 1024)
    owned.launch(["helper"])
    assert owned.poll() is None  # root exited but a descendant remains
    calls.append(("descendant_exited",))
    assert owned.poll() == 0
    owned.close()
    assert calls[0] == ("create", 768)  # stricter tree cap also bounds this serial compression group
    assert calls[-1] == ("close", "owned")
