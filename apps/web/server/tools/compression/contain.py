#!/usr/bin/env python3
"""Apply POSIX rlimits, then exec a compression helper.

Filenames arrive only as argv after ``--``. This process never starts a shell.
``--probe`` reports which limits the platform actually accepts. File-size and
CPU limits are not treated as a resident-memory budget.
"""

from __future__ import annotations

import json
import os
import resource
import sys


def try_limit(name: str, value: int) -> bool:
    limit = getattr(resource, name, None)
    if limit is None:
        return False
    try:
        resource.setrlimit(limit, (value, value))
        soft, _hard = resource.getrlimit(limit)
    except (OSError, OverflowError, ValueError):
        return False
    return soft == value


def probe() -> int:
    memory = 256 * 1024 * 1024
    report = {
        "as": try_limit("RLIMIT_AS", memory),
        "rss": try_limit("RLIMIT_RSS", memory),
        "data": try_limit("RLIMIT_DATA", memory),
        "fsize": try_limit("RLIMIT_FSIZE", memory),
        "cpu": try_limit("RLIMIT_CPU", 30),
    }
    json.dump(report, sys.stdout)
    sys.stdout.write("\n")
    return 0


def option(argv: list[str], flag: str) -> int | None:
    if flag not in argv:
        return None
    index = argv.index(flag)
    if index + 1 >= len(argv):
        return None
    return int(argv[index + 1])


def try_cgroup(memory: int) -> bool:
    """Put this process in its own cgroup before exec, so the helper inherits it."""
    path = os.path.join("/sys/fs/cgroup", f"beian-compression-{os.getpid()}")
    try:
        os.mkdir(path, 0o755)
        with open(os.path.join(path, "memory.max"), "w", encoding="ascii") as handle:
            handle.write(str(memory))
        with open(os.path.join(path, "cgroup.procs"), "w", encoding="ascii") as handle:
            handle.write(str(os.getpid()))
    except OSError:
        try:
            os.rmdir(path)
        except OSError:
            pass
        return False
    return True


def execute(argv: list[str]) -> int:
    if "--" not in argv:
        sys.stderr.write("containment=invalid\n")
        return 2
    split = argv.index("--")
    opts = argv[:split]
    command = argv[split + 1 :]
    if len(command) < 1 or not command[0] or command[0].startswith("-"):
        sys.stderr.write("containment=invalid\n")
        return 2
    memory = option(opts, "--as")
    if memory is not None:
        cgroup_ok = try_cgroup(memory)
        rlimit_ok = (
            try_limit("RLIMIT_AS", memory)
            or try_limit("RLIMIT_RSS", memory)
            or try_limit("RLIMIT_DATA", memory)
        )
        if not cgroup_ok and not rlimit_ok:
            sys.stderr.write("containment=unavailable\n")
            return 3
    fsize = option(opts, "--fsize")
    cpu = option(opts, "--cpu")
    if fsize is not None:
        try_limit("RLIMIT_FSIZE", fsize)
    if cpu is not None:
        try_limit("RLIMIT_CPU", cpu)
    sys.stderr.write("containment=ok\n")
    os.execv(command[0], command)
    return 127


def main() -> int:
    argv = sys.argv[1:]
    if "--probe" in argv:
        return probe()
    return execute(argv)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        sys.stderr.write(f"containment=error:{error.__class__.__name__}\n")
        raise SystemExit(3)
