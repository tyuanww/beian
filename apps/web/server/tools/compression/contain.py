#!/usr/bin/env python3
"""Own the helper process tree. Probe and execution use the same OS container.

No RLIMIT_RSS claim: accepting setrlimit does not enforce aggregate RSS.
Windows uses owned, atomically assigned Job Objects (commit cap plus sampled
aggregate working set). Linux requires a delegated cgroup v2 memory controller.
"""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "workers" / "packaging"))
MEMORY = 768 * 1024 * 1024
GROUP_MEMORY = 1024 * 1024 * 1024


class WindowsContainer:
    mechanism = "windows-job-commit+tree-rss-monitor"

    def __init__(self, memory, group_memory):
        from windows_job_native import NativeWindowsJobs
        self.api = NativeWindowsJobs()
        self.job = self.api.create("Local\\beian-compression-" + uuid.uuid4().hex, min(memory, group_memory))
        self.memory = min(memory, group_memory)
        self.process = None

    def launch(self, command):
        self.process = self.api.launch_in_job(self.job, command, os.getcwd())
        self.process["stdin"].close()
        return self.process["stdout"], self.process["stderr"]

    def rss(self):
        # Enumerate only this job's members; never terminate processes by PID.
        from windows_job_native import DWORD, HANDLE, SIZE_T
        class ProcessList(ctypes.Structure):
            _fields_ = [("assigned", DWORD), ("count", DWORD), ("pids", SIZE_T * 4096)]
        class MemoryInfo(ctypes.Structure):
            _fields_ = [("cb", DWORD), ("faults", DWORD)] + [(name, SIZE_T) for name in (
                "peak_working_set", "working_set", "peak_paged", "paged", "peak_nonpaged", "nonpaged", "pagefile", "peak_pagefile")]
        api = self.api.api
        api.OpenProcess.restype, api.OpenProcess.argtypes = HANDLE, [DWORD, ctypes.c_int, DWORD]
        api.K32GetProcessMemoryInfo.restype, api.K32GetProcessMemoryInfo.argtypes = ctypes.c_int, [HANDLE, ctypes.c_void_p, DWORD]
        members = ProcessList()
        self.api.require(api.QueryInformationJobObject(self.job["handle"], 3, ctypes.byref(members), ctypes.sizeof(members), None), "job_members_unknown")
        if members.assigned > 4096 or members.count > 4096:
            raise RuntimeError("job_members_overflow")
        total = 0
        for pid in members.pids[:members.count]:
            handle = api.OpenProcess(0x1000 | 0x10, False, pid)
            if not handle:
                if ctypes.get_last_error() == 87:  # exited since snapshot
                    continue
                raise RuntimeError("job_rss_unknown")
            try:
                info = MemoryInfo()
                info.cb = ctypes.sizeof(info)
                self.api.require(api.K32GetProcessMemoryInfo(handle, ctypes.byref(info), info.cb), "job_rss_unknown")
                total += info.working_set
            finally:
                api.CloseHandle(handle)
        return total

    def poll(self):
        code, active = self.api.state(self.job, self.process)
        if self.api.memory_exceeded(self.job) or self.rss() > self.memory:
            raise RuntimeError("resource_limit")
        return code if code is not None and active == 0 else None

    def close(self):
        # A closed handle is only a safety net, not observed process-tree exit.
        try:
            _, active = self.api.state(self.job, self.process)
            if active:
                self.api.terminate(self.job)
                deadline = time.monotonic() + 5
                while self.api.state(self.job, self.process)[1]:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("close_unconfirmed")
                    time.sleep(0.02)
        finally:
            self.api.close(self.job, self.process)


class LinuxContainer:
    mechanism = "cgroup-v2-memory.max"

    def __init__(self, memory, group_memory):
        self.process = None
        self.group = Path("/sys/fs/cgroup") / ("beian-compression-" + uuid.uuid4().hex)
        self.leaf = self.group / "helper"
        try:
            self.group.mkdir()
            (self.group / "memory.max").write_text(str(group_memory), encoding="ascii")
            (self.group / "memory.swap.max").write_text("0", encoding="ascii")
            (self.group / "cgroup.subtree_control").write_text("+memory", encoding="ascii")
            self.leaf.mkdir()
            (self.leaf / "memory.max").write_text(str(memory), encoding="ascii")
            (self.leaf / "memory.swap.max").write_text("0", encoding="ascii")
            (self.leaf / "memory.oom.group").write_text("1", encoding="ascii")
            if not (self.group / "cgroup.kill").exists():
                raise RuntimeError("cgroup_kill_unavailable")
        except BaseException:
            self.close()
            raise

    def launch(self, command):
        def enter():
            # Single-threaded before spawn: attach before executing any helper.
            (self.leaf / "cgroup.procs").write_text(str(os.getpid()), encoding="ascii")
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=enter)
        return self.process.stdout, self.process.stderr

    def poll(self):
        events = dict(line.split() for line in (self.leaf / "memory.events").read_text().splitlines())
        if int(events.get("oom_kill", 0)):
            raise RuntimeError("resource_limit")
        code = self.process.poll()
        populated = "populated 1" in (self.group / "cgroup.events").read_text()
        return code if code is not None and not populated else None

    def close(self):
        confirmed = True
        if self.group.exists():
            try:
                (self.group / "cgroup.kill").write_text("1", encoding="ascii")
                deadline = time.monotonic() + 5
                while "populated 1" in (self.group / "cgroup.events").read_text():
                    if time.monotonic() >= deadline:
                        raise RuntimeError("close_unconfirmed")
                    time.sleep(0.02)
            except OSError:
                confirmed = False
        if self.process:
            self.process.wait(timeout=5)
        for path in (self.leaf, self.group):
            try:
                path.rmdir()
            except OSError:
                pass
        if not confirmed:
            raise RuntimeError("close_unconfirmed")


def container(memory=MEMORY, group_memory=GROUP_MEMORY):
    if not 0 < memory <= group_memory:
        raise ValueError("invalid_budget")
    if sys.platform == "win32":
        return WindowsContainer(memory, group_memory)
    if sys.platform == "linux":
        return LinuxContainer(memory, group_memory)
    raise RuntimeError("platform_budget_unavailable")


def check_disk(work_dir, candidate_bytes, disk_bytes):
    if work_dir is None:
        return
    total, count = 0, 0
    for directory, dirs, files in os.walk(work_dir, followlinks=False):
        count += len(dirs) + len(files)
        if count > 4096:
            raise RuntimeError("resource_limit")
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                raise RuntimeError("resource_limit")
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                continue
            total += size
            if size > candidate_bytes or total > disk_bytes:
                raise RuntimeError("resource_limit")


def write_close(path, token):
    dest = Path(path)
    temp = dest.with_name(dest.name + "." + token + ".tmp")
    with temp.open("w", encoding="utf8") as stream:
        json.dump({"schema": "compression-close/1", "token": token, "pid": os.getpid(), "closed": True}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, dest)


def run(command, memory, group_memory, seconds, work_dir=None, candidate_bytes=128 * 1024 * 1024, disk_bytes=2 * 1024 ** 3, close_file=None, token=None):
    owned = container(memory, group_memory)
    threads = []
    over_output = threading.Event()
    output_bytes = [0]
    lock = threading.Lock()
    def forward(stream, destination):
        try:
            while chunk := stream.read(8192):
                with lock:
                    output_bytes[0] += len(chunk)
                    if output_bytes[0] > 1024 * 1024:
                        over_output.set()
                        return
                    destination.buffer.write(chunk)
                    destination.buffer.flush()
        except (OSError, ValueError):
            over_output.set()
        finally:
            stream.close()
    try:
        stdout, stderr = owned.launch(command)
        sys.stderr.write("containment=ok\n")
        for stream, destination in ((stdout, sys.stdout), (stderr, sys.stderr)):
            thread = threading.Thread(target=forward, args=(stream, destination), daemon=True)
            threads.append(thread)
            thread.start()
        deadline = time.monotonic() + seconds
        while True:
            if close_file:
                cancel = Path(str(close_file) + ".cancel")
                if cancel.exists() and cancel.stat().st_size == 32 and cancel.read_text(encoding="ascii") == token:
                    raise RuntimeError("cancelled")
            if over_output.is_set() or time.monotonic() >= deadline:
                raise RuntimeError("resource_limit")
            check_disk(work_dir, candidate_bytes, disk_bytes)
            code = owned.poll()
            if code is not None:
                return code
            time.sleep(0.02)
    finally:
        owned.close()
        for thread in threads:
            thread.join(2)
        if close_file:
            write_close(close_file, token)


def probe():
    # Exercise atomic launch, membership, accounting and teardown on the same
    # path as production. No business documents/tools or native apps are used.
    try:
        owned = container()
        mechanism = owned.mechanism
        owned.close()
        code = run([sys.executable, "-c", "pass"], MEMORY, GROUP_MEMORY, 3)
        if code != 0:
            raise RuntimeError("probe_failed")
        return {"enforced": True, "mechanism": mechanism, "tree_bytes": MEMORY, "group_bytes": GROUP_MEMORY}
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        return {"enforced": False, "mechanism": "platform-budget-unavailable"}


def main():
    if sys.argv[1:] == ["--probe"]:
        print(json.dumps(probe()))
        return 0
    split = sys.argv.index("--")
    options, command = sys.argv[1:split], sys.argv[split + 1:]
    def number(flag):
        return int(options[options.index(flag) + 1])
    if not command or not os.path.isabs(command[0]):
        raise ValueError("invalid_command")
    token = options[options.index("--compression-token") + 1] if "--compression-token" in options else None
    close_file = options[options.index("--closed-file") + 1] if "--closed-file" in options else None
    if close_file and (not os.path.isabs(close_file) or not token or len(token) != 32 or any(c not in "0123456789abcdef" for c in token)):
        raise ValueError("invalid_execution_identity")
    # POSIX fallback; normal cancellation uses the token-bound file on all hosts.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    return run(command, number("--as"), number("--group-memory"), number("--cpu"),
               options[options.index("--work-dir") + 1] if "--work-dir" in options else None,
               number("--fsize"), number("--disk"), close_file, token)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        sys.stderr.write("containment=" + ("resource_limit" if str(error) == "resource_limit" else "unavailable") + "\n")
        raise SystemExit(3)
