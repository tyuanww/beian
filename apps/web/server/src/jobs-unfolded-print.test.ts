import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-unfolded-print-");
const { DATA_DIR, PYTHON } = await import("./config.js");
const { queueSnapshot, reclaimOnBoot, requestUnfoldedPrint, resetJobsTestHooks, setJobsLiveForTest, setJobsTestHooks, tryStart } = await import("./jobs.js");
const { beginStructureConfirmation, deleteMockup, publicMockup, publicMockupSummary, readMockupFromDisk, saveMockup } = await import("./mockup.js");
const { runUnfoldedPublish, workerCommandMatches } = await import("./workers.js");

const viewer = { id: "reviewer", name: "审核员", admin: false };
const id = "ab00ab00ab01";
const otherId = "ab00ab00ab02";
const net = {
  schema: "unfolded-print-source/1",
  assembly: "semantic-net",
  attestation: { schema: "unfolded-separation-attestation/1", method: "semantic-identity", hidden_roles: ["cut", "crease"], covers_blank_structure: true },
  panels: [
    { id: "glue", role: "glue", bounds_mm: [0, 30, 20, 70] },
    { id: "back", role: "back", bounds_mm: [20, 30, 70, 90] },
    { id: "left", role: "left", bounds_mm: [70, 30, 100, 90] },
    { id: "front", role: "front", bounds_mm: [100, 30, 150, 90] },
    { id: "right", role: "right", bounds_mm: [150, 30, 180, 90] },
    { id: "top", role: "top", bounds_mm: [100, 0, 150, 30] },
    { id: "bottom", role: "bottom", bounds_mm: [100, 90, 150, 120] },
    { id: "tuck", role: "tuck", bounds_mm: [100, 120, 140, 140] },
  ],
  separation: {
    method: "semantic-identity",
    objects: [
      { id: "ink", role: "print", panel_id: "front", bounds_mm: [110, 40, 140, 80] },
      { id: "rule", role: "decoration", panel_id: "front", bounds_mm: [112, 82, 145, 82.15] },
      { id: "knife", role: "cut", panel_id: "front", bounds_mm: [100, 30, 150, 90] },
      { id: "fold", role: "crease", panel_id: "front", bounds_mm: [100, 30, 150, 31] },
      { id: "dim", role: "dimension", panel_id: "glue", bounds_mm: [2, 40, 18, 42] },
      { id: "note", role: "production", panel_id: "tuck", bounds_mm: [102, 122, 130, 136] },
    ],
  },
};

function seed(tid = id, payload: unknown = net) {
  const dir = join(DATA_DIR, "mockups", tid);
  mkdirSync(join(dir, "assets"), { recursive: true });
  execFileSync(PYTHON, ["-c", "import pymupdf,sys; d=pymupdf.open(); p=d.new_page(width=180*72/25.4,height=140*72/25.4); p.insert_text((300,150),'Original artwork'); p.draw_rect((310,160,360,200),fill=(0.4,0.6,0.2)); p.draw_line((300,220),(380,220)); d.save(sys.argv[1]); d.close()", join(dir, "artwork.pdf")]);
  writeFileSync(join(dir, "source.ai"), "%AI synthetic");
  writeFileSync(join(dir, "unfolded-source.json"), JSON.stringify(payload));
  saveMockup({
    id: tid, status: "done", job_kind: "mockup", job_status: "succeeded", created_at: "2026-10-09T00:00:00Z",
    structure_artwork_path: join(dir, "artwork.pdf"),
    owner: viewer.id, files: [], source_path: join(dir, "source.ai"),
  });
  return dir;
}

async function settled(tid = id) {
  for (let n = 0; n < 1000; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const job = readMockupFromDisk(tid);
    const status = job?.unfolded_print_request?.status || "";
    if (status === "succeeded" || status === "failed") return job!;
  }
  throw new Error("unfolded print did not settle");
}

function pageMillimetres(path: string): { width: number; height: number } {
  const raw = execFileSync(PYTHON, ["-c", "import pymupdf,sys; d=pymupdf.open(sys.argv[1]); p=d[0]; print(round(p.mediabox.width*25.4/72,3), round(p.mediabox.height*25.4/72,3), len(p.get_drawings()))", path], { encoding: "utf8" });
  const [width, height, drawings] = raw.trim().split(/\s+/).map(Number);
  assert.equal(drawings, 2);
  return { width, height };
}

afterEach(() => {
  resetJobsTestHooks();
  rmSync(join(DATA_DIR, "mockups"), { recursive: true, force: true });
});

it("publishes a 1:1 net and keeps the source file unchanged", async () => {
  const dir = seed();
  const before = readFileSync(join(dir, "unfolded-source.json"));
  let nativeCalls = 0;
  setJobsTestHooks({
    runUnfoldedPublish,
    runUnfoldedNative: async () => { nativeCalls += 1; return { code: 1, stdout: "", stderr: "", timedOut: false }; },
  });
  const accepted = await requestUnfoldedPrint(id, viewer);
  assert.equal(accepted.unfolded_print_request?.status, "queued");
  const job = await settled();
  assert.equal(nativeCalls, 0);
  assert.equal(job.unfolded_print_request?.status, "succeeded");
  assert.deepEqual(readFileSync(join(dir, "unfolded-source.json")), before);
  const pdf = join(dir, "assets", "unfolded-print.pdf");
  const size = pageMillimetres(pdf);
  assert.deepEqual(size, { width: 180, height: 140 });
  const body = JSON.stringify(publicMockup(job));
  assert.equal(publicMockup(job).unfolded_print.status, "ready");
  assert.equal(publicMockup(job).unfolded_print.file_key, "unfolded_print");
  assert.equal(publicMockup(job).unfolded_print.width_mm, 180);
  assert.equal(publicMockup(job).unfolded_print.height_mm, 140);
  assert.equal(body.includes("worker_pid"), false);
  assert.equal(body.includes("source_sha256"), false);
  assert.equal(body.includes(DATA_DIR), false);
  assert.equal("unfolded_print" in publicMockupSummary(job), false);
  const again = await requestUnfoldedPrint(id, viewer);
  assert.equal(again.unfolded_print_request?.id, job.unfolded_print_request?.id);
});

it("rejects an unreliable separation without writing a pdf", async () => {
  const dir = seed(id, { ...net, separation: { ...net.separation, method: "color" } });
  let calls = 0;
  setJobsTestHooks({ runUnfoldedPublish: async () => { calls += 1; return { code: 0, stdout: "", stderr: "", timedOut: false }; } });
  await assert.rejects(requestUnfoldedPrint(id, viewer), (error: { reason?: string }) => error.reason === "separation_unreliable");
  assert.equal(calls, 0);
  assert.equal(readMockupFromDisk(id)?.unfolded_print_request?.status, "failed");
  assert.equal(publicMockup(readMockupFromDisk(id)!).unfolded_print.reason, "separation_unreliable");
  assert.equal(readMockupFromDisk(id)?.unfolded_print_asset, undefined);
  assert.equal(readFileSync(join(dir, "unfolded-source.json"), "utf8").includes("color"), true);
});

it("names missing geometry and a missing source separately", async () => {
  seed();
  rmSync(join(DATA_DIR, "mockups", id, "unfolded-source.json"));
  await assert.rejects(requestUnfoldedPrint(id, viewer), (error: { reason?: string }) => error.reason === "geometry_incomplete");
  const bare = "ab00ab00ab03";
  const dir = join(DATA_DIR, "mockups", bare);
  mkdirSync(dir, { recursive: true });
  saveMockup({ id: bare, status: "done", job_kind: "mockup", job_status: "succeeded", created_at: "2026-10-09T00:00:00Z", owner: viewer.id, files: [] });
  await assert.rejects(requestUnfoldedPrint(bare, viewer), (error: { reason?: string }) => error.reason === "source_missing");
});

it("keeps a queued publish on the blender drain and blocks delete", async () => {
  seed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setJobsTestHooks({ runUnfoldedPublish: async (opts) => { opts.onSpawn?.(4242); await gate; return { code: 1, stdout: "{\"ok\":false,\"reason\":\"export_failed\"}", stderr: "", timedOut: false }; } });
  const accepted = await requestUnfoldedPrint(id, viewer);
  for (let n = 0; n < 50 && readMockupFromDisk(id)?.unfolded_print_request?.status !== "running"; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(queueSnapshot().blender.running, 1);
  assert.throws(() => deleteMockup(id), (error: { status?: number }) => error.status === 409);
  assert.throws(() => beginStructureConfirmation(readMockupFromDisk(id)!), (error: { status?: number }) => error.status === 409);
  const again = await requestUnfoldedPrint(id, viewer);
  assert.equal(again.unfolded_print_request?.id, accepted.unfolded_print_request?.id);
  release();
  await settled();
});

it("does not let a late callback replace a newer attempt or an existing pdf", async () => {
  const dir = seed();
  const previous = Buffer.from("%PDF-1.4\nold");
  writeFileSync(join(dir, "assets", "unfolded-print.pdf"), previous);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setJobsTestHooks({ runUnfoldedPublish: async (opts) => {
    opts.onSpawn?.(77);
    await gate;
    writeFileSync(opts.output, "%PDF-1.4\nlate");
    return { code: 0, stdout: JSON.stringify({ ok: true, reason: null, width_mm: 10, height_mm: 10 }), stderr: "", timedOut: false };
  } });
  await requestUnfoldedPrint(id, viewer);
  for (let n = 0; n < 50 && !readMockupFromDisk(id)?.unfolded_print_request?.worker_pid; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const job = readMockupFromDisk(id)!;
  job.unfolded_print_request!.id = "b".repeat(32);
  saveMockup(job);
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(readFileSync(join(dir, "assets", "unfolded-print.pdf")), previous);
  assert.equal(readMockupFromDisk(id)?.unfolded_print_request?.id, "b".repeat(32));
});

it("requeues a publish only after the worker pid is confirmed gone", () => {
  const dir = seed();
  const requestId = "c".repeat(32);
  const source = createHash("sha256").update(readFileSync(join(dir, "unfolded-source.json"))).digest("hex");
  const job = readMockupFromDisk(id)!;
  job.unfolded_print_request = {
    id: requestId, status: "running", mode: "publish_existing", created_at: "2026-10-09T00:00:01Z",
    actor_id: viewer.id, source_sha256: source, generation_id: "", worker_pid: 55,
  };
  saveMockup(job);
  setJobsTestHooks({ inspectWorker: () => "unknown", runUnfoldedPublish: async () => { throw new Error("must not restart"); } });
  reclaimOnBoot();
  assert.equal(readMockupFromDisk(id)?.unfolded_print_request?.status, "running");
  assert.equal(readMockupFromDisk(id)?.unfolded_print_request?.id, requestId);
  resetJobsTestHooks();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setJobsTestHooks({ inspectWorker: () => "missing", runUnfoldedPublish: async () => { await gate; return { code: 1, stdout: "", stderr: "", timedOut: false }; } });
  reclaimOnBoot();
  const restarted = readMockupFromDisk(id)?.unfolded_print_request;
  assert.notEqual(restarted?.id, requestId);
  assert.equal(restarted?.status === "queued" || restarted?.status === "running", true);
  assert.equal(queueSnapshot().blender.queued + queueSnapshot().blender.running >= 1, true);
  release();
});

it("publishes a native export only after a separate close record and ignores worker millimetres", async () => {
  const dir = seed(id, {
    ...net,
    assembly: "attested-pdf",
    export: "native",
    separation: undefined,
    attestation: {
      schema: "unfolded-separation-attestation/1",
      method: "semantic-identity",
      hidden_roles: ["cut", "crease", "dimension", "production"],
      covers_blank_structure: true,
    },
  });
  const original = readFileSync(join(dir, "source.ai"));
  setJobsTestHooks({
    illustratorHostReady: true,
    runUnfoldedPublish,
    runUnfoldedNative: async (opts) => {
      const root = dirname(opts.configPath);
      const config = JSON.parse(readFileSync(opts.configPath, "utf8"));
      assert.notEqual(config.application, config.source_ai);
      assert.match(config.source_ai, /source\.ai$/);
      const printPdf = join(root, "print.pdf");
      execFileSync(PYTHON, ["-c", "import pymupdf,sys; d=pymupdf.open(); d.new_page(width=180*72/25.4, height=140*72/25.4); d.save(sys.argv[1]); d.close()", printPdf]);
      writeFileSync(join(root, "close.json"), JSON.stringify({
        protocol: "beian.illustrator.export/2",
        request_kind: "unfolded_print",
        attempt_id: opts.executionId,
        source_sha256: config.source_sha256,
        document_closed: true,
        bridge_exited: true,
        inflight: false,
        lock_returnable: true,
      }));
      return { code: 0, stdout: JSON.stringify({ width_mm: 1, height_mm: 1 }), stderr: "", timedOut: false };
    },
  });
  await requestUnfoldedPrint(id, viewer);
  const job = await settled();
  assert.equal(job.unfolded_print_request?.status, "succeeded");
  assert.equal(publicMockup(job).unfolded_print.width_mm, 180);
  assert.equal(publicMockup(job).unfolded_print.height_mm, 140);
  assert.deepEqual(readFileSync(join(dir, "source.ai")), original);
  assert.equal(queueSnapshot().illustrator.running, 0);
});

for (const failure of [8, 2, "throw"] as const) it(`holds the illustrator slot after ${failure} without close evidence and blocks another native`, async () => {
  seed();
  seed(otherId, { ...net, assembly: "attested-pdf", export: "native", separation: undefined, attestation: {
    schema: "unfolded-separation-attestation/1", method: "semantic-identity",
    hidden_roles: ["cut", "crease", "dimension", "production"], covers_blank_structure: true,
  } });
  const first = readMockupFromDisk(id)!;
  writeFileSync(join(DATA_DIR, "mockups", id, "unfolded-source.json"), JSON.stringify({ ...net, assembly: "attested-pdf", export: "native", attestation: {
    schema: "unfolded-separation-attestation/1", method: "semantic-identity",
    hidden_roles: ["cut", "crease", "dimension", "production"], covers_blank_structure: true,
  } }));
  void first;
  let calls = 0;
  setJobsTestHooks({
    illustratorHostReady: true,
    runUnfoldedNative: async () => { calls += 1; if (failure === "throw") throw new Error("bridge connection lost"); return { code: failure, stdout: "", stderr: "", timedOut: false }; },
  });
  await requestUnfoldedPrint(id, viewer);
  for (let n = 0; n < 50 && publicMockup(readMockupFromDisk(id)!).unfolded_print.reason !== "close_unconfirmed"; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(publicMockup(readMockupFromDisk(id)!).unfolded_print.status, "running");
  assert.equal(publicMockup(readMockupFromDisk(id)!).unfolded_print.file_key, undefined);
  assert.equal(queueSnapshot().illustrator.running, 1);
  await requestUnfoldedPrint(otherId, viewer);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(readMockupFromDisk(otherId)?.unfolded_print_request?.status, "queued");
  tryStart();
  assert.equal(calls, 1);
});

for (const event of ["save_timeout", "save_source_changed"] as const) it(`unfolded ${event} sends the watchdog Feishu alert for the mockup`, async () => {
  seed(id, { ...net, assembly: "attested-pdf", export: "native", separation: undefined, attestation: {
    schema: "unfolded-separation-attestation/1", method: "semantic-identity",
    hidden_roles: ["cut", "crease", "dimension", "production"], covers_blank_structure: true,
  } });
  const alerts: string[] = [];
  setJobsTestHooks({
    illustratorHostReady: true,
    watchdogAlert: async (task, kind, open) => { alerts.push(`${task.id}:${kind}:${open}`); },
    runUnfoldedNative: async (opts) => {
      const config = JSON.parse(readFileSync(opts.configPath, "utf8"));
      if (event === "save_timeout") writeFileSync(join(dirname(opts.configPath), "close.json"), JSON.stringify({
        protocol: "beian.illustrator.export/2", request_kind: "unfolded_print", attempt_id: opts.executionId, source_sha256: config.source_sha256,
        document_closed: true, bridge_exited: true, inflight: false, lock_returnable: true,
      }));
      return { code: event === "save_timeout" ? 4 : 8, stdout: JSON.stringify({ ok: false, reason: event }), stderr: "", timedOut: false };
    },
  });
  await requestUnfoldedPrint(id, viewer);
  for (let n = 0; n < 100 && alerts.length === 0; n += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(alerts, [`${id}:${event}:mockup`]);
  const pub = publicMockup(readMockupFromDisk(id)!).unfolded_print;
  assert.equal(pub.file_key, undefined);
  if (event === "save_source_changed") {
    assert.equal(pub.status, "running"); assert.equal(queueSnapshot().illustrator.running, 1);
  } else {
    assert.notEqual(pub.status, "running"); assert.equal(queueSnapshot().illustrator.running, 0);
  }
});

it("drops a ready file when the generation changes", async () => {
  const dir = seed();
  const job = readMockupFromDisk(id)!;
  job.current_render_generation_id = "g0-legacy-original";
  saveMockup(job);
  setJobsTestHooks({ runUnfoldedPublish });
  await requestUnfoldedPrint(id, viewer);
  const ready = await settled();
  assert.equal(publicMockup(ready).unfolded_print.status, "ready");
  ready.current_render_generation_id = "g1-box-aaaaaaaa-bbbbbbbb";
  saveMockup(ready);
  const view = publicMockup(readMockupFromDisk(id)!);
  assert.equal(view.unfolded_print.status, "failed");
  assert.equal(view.unfolded_print.reason, "source_changed");
  assert.equal(view.unfolded_print.file_key, undefined);
  assert.equal(readFileSync(join(dir, "assets", "unfolded-print.pdf")).subarray(0, 5).toString(), "%PDF-");
});

it("matches publish and native worker commands without treating a result path as ownership", () => {
  assert.equal(workerCommandMatches(
    `python export_unfolded_print.py --execution-id ${"a".repeat(32)} --job-dir /tmp/mockups/${id}`,
    { kind: "unfolded_print", id, executionId: "a".repeat(32), mode: "publish_existing" },
  ), true);
  assert.equal(workerCommandMatches(
    `python illustrator/illustrator_worker.py /tmp/mockups/${id}/.unfolded-${"d".repeat(32)}/config.json`,
    { kind: "unfolded_print", id, executionId: "d".repeat(32), mode: "native_export" },
  ), true);
  assert.equal(workerCommandMatches("python export_unfolded_print.py --execution-id abc --job-dir /tmp/other", {
    kind: "unfolded_print", id, executionId: "a".repeat(32), mode: "publish_existing",
  }), false);
});

it("adopts a normal preflight net and rejects a source mismatch before native dispatch", async () => {
  const dir = seed();
  rmSync(join(dir, "unfolded-source.json"));
  const project = join(dir, "output", "synthetic");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "resolved_job.json"), JSON.stringify({ structure_engine: "v2" }));
  const sourceHash = createHash("sha256").update(readFileSync(join(dir, "source.ai"))).digest("hex");
  writeFileSync(join(project, "unfolded-source.json"), JSON.stringify({ ...net, assembly: "attested-pdf", export: "native", source_ai_sha256: sourceHash }));
  setJobsTestHooks({ illustratorHostReady: true, runUnfoldedNative: async () => ({ code: 8, stdout: "", stderr: "", timedOut: false }) });
  await requestUnfoldedPrint(id, viewer);
  assert.equal(readMockupFromDisk(id)?.unfolded_print_request?.mode, "native_export");
  assert.equal(JSON.parse(readFileSync(join(dir, "unfolded-source.json"), "utf8")).source_ai_sha256, sourceHash);
  // Do not race a native call with mutation; use an independent job.
  const other = seed(otherId);
  const project2 = join(other, "output");
  mkdirSync(project2);
  writeFileSync(join(project2, "resolved_job.json"), "{}");
  writeFileSync(join(project2, "unfolded-source.json"), JSON.stringify({ ...net, source_ai_sha256: "wrong" }));
  await assert.rejects(requestUnfoldedPrint(otherId, viewer), (error: unknown) => (error as { reason?: string }).reason === "source_changed");
});

// ---- WebP 旁路：入口删旁路的行为测试（方案 v2.1 §4.2）----
const glbVariant = await import("./glbWebpVariant.js");

function plantGlbVariant(jobId: string): string {
  const dir = glbVariant.glbWebpVariantDir(jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "box.glb.webpv"), "variant");
  writeFileSync(join(dir, "box.glb.webpv.json"), "{}");
  return dir;
}

const GLB_VARIANT_ENTRIES = new Set(["claimMockup", "retryMockup", "repairMockupPrintFaces", "claimPrintFaceRepair", "recoverPrintFaceRepairsOnBoot",
  "claimUnfoldedPublish", "relightMockupStudio", "claimGenerationMutation", "runGenerationMutation", "occupyUnconfirmedGenerationBlenderFence",
  "recoverInterruptedMutation", "recoverRenderGenerationsOnBoot", "tryStart"]);

/** dropGlbWebpVariant 之上最近的登记入口函数（跳过锁回调等匿名帧）。 */
function dropCaller(): string {
  const frames = (new Error().stack || "").split("\n");
  const at = frames.findIndex((line) => /\bdropGlbWebpVariant\b/.test(line));
  for (const line of frames.slice(at + 1)) {
    const name = (/at (?:async )?([\w$.<>]+)/.exec(line)?.[1] || "").split(".").pop()!;
    if (GLB_VARIANT_ENTRIES.has(name)) return name;
  }
  return "?";
}

/**
 * 只放行 target 直接调用的删旁路；其他入口的删除模拟 EPERM（文件留着）。
 * 结束时旁路目录为空，就证明是 target 自己删的，且记录 meta 先于旁路。
 */
async function expectEntryDropsVariant(jobId: string, target: string, action: () => unknown | Promise<unknown>): Promise<void> {
  const dir = plantGlbVariant(jobId);
  const order: string[] = [];
  const callers: string[] = [];
  glbVariant.setGlbWebpVariantUnlinkForTest((path) => {
    const caller = dropCaller();
    callers.push(caller);
    if (caller !== target) throw Object.assign(new Error(`EPERM simulated for ${caller}`), { code: "EPERM" });
    order.push(path.slice(dir.length + 1));
    unlinkSync(path);
  });
  try {
    await action();
  } finally {
    glbVariant.setGlbWebpVariantUnlinkForTest(null);
  }
  assert.deepEqual(readdirSync(dir), [], `${target} 没有删旁路；删旁路调用者：${callers.join(",") || "无"}`);
  assert.deepEqual(order, ["box.glb.webpv.json", "box.glb.webpv"], "meta 必须先于旁路被删");
}

it("glb webp variant: claimUnfoldedPublish drops the variant when it takes the Blender slot", async () => {
  seed();
  setJobsTestHooks({
    runUnfoldedPublish: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    runUnfoldedNative: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
  });
  await expectEntryDropsVariant(id, "claimUnfoldedPublish", async () => { await requestUnfoldedPrint(id, viewer); await settled(); });
});

it("glb webp variant: tryStart re-occupying an interrupted publish drops the variant", async () => {
  seed();
  setJobsLiveForTest("blender", "another-job");
  try {
    await requestUnfoldedPrint(id, viewer);
    const job = readMockupFromDisk(id)!;
    assert.equal(job.unfolded_print_request?.mode, "publish_existing");
    job.unfolded_print_request!.status = "running";
    saveMockup(job);
    await expectEntryDropsVariant(id, "tryStart", () => { setJobsLiveForTest("blender", null); tryStart(); });
    assert.equal(queueSnapshot().blender.running, 1);
  } finally { setJobsLiveForTest("blender", null); }
});
