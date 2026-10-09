import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it, mock } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-compression-process-");
const { executeCompressionFile } = await import("./compressionExecute.js");

for (const confirmed of [true, false]) it(`tool cancellation requires observed tree close; confirmed=${confirmed}`, async () => {
  const events: string[] = [];
  const abort = new AbortController();
  const path = join(process.env.WB_DATA_DIR!, "closed.json");
  const token = "a".repeat(32);
  const spawnSyncOriginal = childProcess.spawnSync;
  mock.method(childProcess, "spawnSync", (...args: Parameters<typeof childProcess.spawnSync>) => {
    if ((args[1] as string[])?.includes("--probe")) return { status: 0, stdout: JSON.stringify({ enforced: true, mechanism: "synthetic" }) };
    return spawnSyncOriginal(...args);
  });
  mock.method(childProcess, "spawn", (_command: string, args: string[], options: { signal?: AbortSignal }) => {
    events.push("spawn"); assert.deepEqual(events, ["begin", "spawn"]);
    assert.equal(args[args.indexOf("--compression-token") + 1], token);
    assert.equal(args[args.indexOf("--closed-file") + 1], path);
    assert.equal(options.signal, undefined);
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill() { assert.fail("must not kill supervisor on Windows cancellation"); } });
    queueMicrotask(() => {
      abort.abort();
      assert.equal(readFileSync(path + ".cancel", "utf8"), token);
      events.push("tree-closed");
      writeFileSync(path, JSON.stringify({ token, closed: confirmed }));
      child.emit("close", 2);
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const pending = executeCompressionFile({ batchId: "abcdefabcdef", token, sourcePath: "synthetic.jpg", outputPath: join(process.env.WB_DATA_DIR!, "out.jpg"), signal: abort.signal,
      file: { id: "asset1", name: "synthetic.jpg", media_type: "image/jpeg", status: "running", input_bytes: 100, output_bytes: null, reason: null, sha256: "a".repeat(64), manual_retries: 0, last_retry_at: null, policy_fingerprint: "synthetic", tool_generation: "synthetic" },
      capability: { budget: "enforced", mechanism: "synthetic", toolsReady: true, missing: [], diskFreeBytes: 8e9, toolGeneration: "synthetic", policyFingerprint: "synthetic", versions: { sharp: "test", qpdf: null, java: null, pdfbox: null } },
      processObserver: { begin() { events.push("begin"); return { token, closePath: path }; }, spawned(pid) { events.push("persist-pid"); assert.equal(pid, 12345); }, notSpawned() { assert.fail("process spawned"); }, closed() { events.push("verify-close"); return JSON.parse(readFileSync(path, "utf8")).closed === true; } },
    });
    if (confirmed) { const result = await pending; assert.equal(result.reason, "timed_out"); assert.equal(result.publish, "none"); }
    else await assert.rejects(pending, /压缩进程树尚未确认关闭/);
    assert.deepEqual(events, ["begin", "spawn", "persist-pid", "tree-closed", "verify-close"]);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
