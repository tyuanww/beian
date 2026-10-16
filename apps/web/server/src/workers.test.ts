import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-workers-");

const {
  WORKER_OUTPUT_LIMIT_BYTES,
  killTree,
  pidAlive,
  runPython,
  scheduleForcedStop,
  compareArgs,
  reworkArgs,
  verbatimMemoryFailure,
  verbatimProbeSentence,
  workerCommandMatches,
} = await import("./workers.js");

describe("verbatim argv", () => {
  const base = { tid: "0123456789ab", excel: "/tmp/a.xlsx", pdf: "/tmp/a.pdf", productName: "品", title: "品", surface: "carton", actor: "审" };
  it("leaves the off switch identical to today", () => {
    const args = compareArgs(base);
    assert.equal(args.includes("--max-pages"), false);
    assert.equal(args.includes("--verbatim-check"), false);
    assert.deepEqual(args.slice(0, 4), ["-m", "app.cli", "compare", "--tid"]);
  });
  it("adds max-pages 1 only when the switch is on", () => {
    const args = compareArgs(base, { modelDir: "/opt/models" });
    assert.deepEqual(args.slice(-5), ["--verbatim-check", "--max-pages", "1", "--model-dir", "/opt/models"]);
    assert.equal(reworkArgs({ tid: base.tid, pdf: base.pdf, actor: base.actor }).includes("--max-pages"), false);
    assert.equal(verbatimMemoryFailure("SIGKILL"), "这一单认字超出内存，没有结果");
    assert.equal(verbatimMemoryFailure("SIGTERM"), null);
  });
});

describe("verbatim probe sentence", () => {
  it("keeps the public sentence and drops paths", () => {
    assert.equal(verbatimProbeSentence(0, ""), null);
    assert.equal(verbatimProbeSentence(2, "认字组件没装上，没有结果"), "认字出了问题，请联系管理员");
    assert.equal(verbatimProbeSentence(2, "认字依赖没装齐"), "认字出了问题，请联系管理员");
    assert.equal(verbatimProbeSentence(2, "D:\\modules\\missing"), "认字出了问题，请联系管理员");
    assert.equal(verbatimProbeSentence(1, "Traceback"), "认字出了问题，请联系管理员");
  });
});

describe("killTree", () => {
  it("no-ops on missing pids", () => {
    killTree(0);
    killTree(-1);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-3), false);
  });

  it("does not throw when the pid is already gone", () => {
    assert.doesNotThrow(() => killTree(999_999_991, true));
  });
});

describe("verbatim probe stop", () => {
  function liveChild(script: string) {
    return spawn(process.execPath, ["-e", script], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    });
  }

  async function untilSpawn(child: ReturnType<typeof spawn>): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    assert.ok(child.pid);
    return child.pid;
  }

  it("ends the process on the first signal and cancels the follow-up", async () => {
    const child = liveChild("setInterval(() => {}, 1000);");
    try {
      const pid = await untilSpawn(child);
      let exited = false;
      child.once("exit", () => { exited = true; });
      const cancel = scheduleForcedStop(pid, () => exited, 2_000);
      killTree(pid, false);
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      cancel();
      assert.equal(exited, true);
      assert.equal(pidAlive(pid), false);
    } finally {
      if (child.pid && pidAlive(child.pid)) killTree(child.pid, true);
    }
  });

  it("force-stops a process that ignores the first signal", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 500);"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    try {
      const pid = await untilSpawn(child);
      await new Promise<void>((resolve, reject) => {
        let text = "";
        child.stdout?.on("data", (buf: Buffer) => {
          text += buf.toString("utf8");
          if (text.includes("ready")) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("进程在忽略信号之前就退出了")));
      });
      let exited = false;
      child.once("exit", () => { exited = true; });
      const started = Date.now();
      const cancel = scheduleForcedStop(pid, () => exited, 200);
      killTree(pid, false);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("进程没有在强制结束后退出")), 4_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      cancel();
      assert.ok(Date.now() - started >= 150);
      assert.equal(exited, true);
      assert.equal(pidAlive(pid), false);
    } finally {
      if (child.pid && pidAlive(child.pid)) killTree(child.pid, true);
    }
  });
});

describe("worker process identity", () => {
  it("binds the native supervisor to its exact execution and never confuses it with the worker CLI", () => {
    const executionId = `job:mutation:${"a".repeat(32)}`;
    const expected = {kind:"render_generation" as const,id:"job",mutationId:"mutation",executionId,
      container:"windows-job-object/1" as const};
    const command = `C:\\Python\\python.exe C:\\packaging\\windows_render_supervisor.py --execution-id ${executionId}`;
    assert.equal(workerCommandMatches(command,expected), true);
    assert.equal(workerCommandMatches(command + " extra",expected), false);
    assert.equal(workerCommandMatches(command.replace(executionId,executionId.replace(/a/g,"b")),expected), false);
    assert.equal(workerCommandMatches(command,{...expected,container:undefined}), false);
    assert.equal(workerCommandMatches(`python render_generation.py - --execution-id ${executionId}`,expected), false);
  });
  it("binds generation workers to exact job, mutation, token and CLI position", () => {
    const expected = { kind: "render_generation" as const, id: "job1", mutationId: "m1",
      executionId: `job1:m1:${"a".repeat(32)}` };
    const command = `python /trusted/render_generation.py - --execution-id ${expected.executionId}`;
    assert.equal(workerCommandMatches(command, expected), true);
    for (const bad of [command.replace("job1:m1:", "job2:m1:"), command.replace("job1:m1:", "job1:m2:"),
      command.replace("a".repeat(32), "b".repeat(32)), command.replace("render_generation.py", "pipeline.py"),
      `${command} --execution-id other`, command.replace(" - --execution-id", " request.json --execution-id")]) {
      assert.equal(workerCommandMatches(bad, expected), false);
    }
    assert.equal(workerCommandMatches(command, { ...expected, mutationId: "different" }), false);
  });
  it("requires both the job kind and exact task id", () => {
    const id = "00000000abcd";
    assert.equal(
      workerCommandMatches(`python -m app.cli compare --tid ${id} --data-dir /tmp/data`, { kind: "compare", id }),
      true,
    );
    assert.equal(
      workerCommandMatches(`python -m app.cli rework --tid ${id} --data-dir /tmp/data`, { kind: "compare", id }),
      false,
    );
    assert.equal(
      workerCommandMatches("python -m app.cli compare --tid 00000000abce --data-dir /tmp/data", { kind: "compare", id }),
      false,
    );
  });

  it("recognizes a mockup only when pipeline.py carries the task id path segment", () => {
    const id = "00000000abcd";
    assert.equal(
      workerCommandMatches(`python pipeline.py "C:\\supply\\data\\mockups\\${id}\\manifest.json" --workers 1`, {
        kind: "mockup",
        id,
      }),
      true,
    );
    assert.equal(
      workerCommandMatches("python pipeline.py C:\\supply\\data\\mockups\\00000000abce\\manifest.json --workers 1", {
        kind: "mockup",
        id,
      }),
      false,
    );
  });
});

describe("runPython output bounds", () => {
  it("bounds large output while keeping final JSON and streaming STAGE lines", async () => {
    const stages: string[] = [];
    const result = await runPython({
      args: [
        "-c",
        [
          "import json, sys",
          `sys.stdout.write('x' * ${WORKER_OUTPUT_LIMIT_BYTES + 65_536})`,
          "sys.stdout.write('\\n' + json.dumps({'status': 'pending_review'}) + '\\n')",
          `sys.stderr.write('y' * ${WORKER_OUTPUT_LIMIT_BYTES + 65_536})`,
          "sys.stderr.write('\\nSTAGE ocr\\n')",
        ].join("; "),
      ],
      timeoutMs: 10_000,
      onStderrLine: (line) => {
        if (line.startsWith("STAGE ")) stages.push(line);
      },
    });

    assert.equal(result.code, 0);
    assert.ok(Buffer.byteLength(result.stdout) <= WORKER_OUTPUT_LIMIT_BYTES);
    assert.ok(Buffer.byteLength(result.stderr) <= WORKER_OUTPUT_LIMIT_BYTES);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\n/).at(-1) || ""), { status: "pending_review" });
    assert.deepEqual(stages, ["STAGE ocr"]);
  });
});


it("print-face worker identity binds job and attempt, and never matches the packaging pipeline", () => {
  const expected = { kind: "print_faces" as const, id: "aa00aa00aa01", executionId: "a".repeat(32) };
  const command = `python repair_print_faces.py --execution-id ${expected.executionId} --job-dir /tmp/${expected.id} --assets /tmp/staging`;
  assert.equal(workerCommandMatches(command, expected), true);
  assert.equal(workerCommandMatches(command, { ...expected, executionId: "b".repeat(32) }), false);
  assert.equal(workerCommandMatches(command, { ...expected, id: "aa00aa00aa02" }), false);
  assert.equal(workerCommandMatches(command, { kind: "mockup", id: expected.id }), false);
});

it("spawn bookkeeping failure terminates the child before rejecting", async () => {
  let pid = 0;
  await assert.rejects(runPython({ args: ["-c", "import time; time.sleep(30)"], timeoutMs: 1000,
    onSpawn: value => { pid = value; throw new Error("synthetic persist failure"); } }), /synthetic persist failure/);
  assert.ok(pid > 0);
  assert.equal(pidAlive(pid), false);
});

it("native deadline reports timeout while allowing its owned bridge to finish without a kill", async () => {
  const { existsSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const marker = join(process.env.WB_DATA_DIR!, "native-deadline-finished");
  const result = await runPython({ args: ["-c", "import time,pathlib,sys; time.sleep(0.15); pathlib.Path(sys.argv[1]).write_text('finished')", marker], timeoutMs: 10, preserveOnTimeout: true });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 8);
  for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(existsSync(marker), true);
  rmSync(marker);
});
