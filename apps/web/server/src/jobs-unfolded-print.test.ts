import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-unfolded-print-");
const { DATA_DIR, PYTHON } = await import("./config.js");
const { queueSnapshot, reclaimOnBoot, requestUnfoldedPrint, resetJobsTestHooks, setJobsTestHooks, tryStart } = await import("./jobs.js");
const { beginStructureConfirmation, deleteMockup, publicMockup, publicMockupSummary, readMockupFromDisk, saveMockup } = await import("./mockup.js");
const { runUnfoldedPublish, workerCommandMatches } = await import("./workers.js");

const viewer = { id: "reviewer", name: "审核员", admin: false };
const id = "ab00ab00ab01";
const otherId = "ab00ab00ab02";
const net = {
  schema: "unfolded-print-source/1",
  assembly: "semantic-net",
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
  writeFileSync(join(dir, "source.ai"), "%AI synthetic");
  writeFileSync(join(dir, "unfolded-source.json"), JSON.stringify(payload));
  saveMockup({
    id: tid, status: "done", job_kind: "mockup", job_status: "succeeded", created_at: "2026-10-09T00:00:00Z",
    owner: viewer.id, files: [], source_path: join(dir, "source.ai"),
  });
  return dir;
}

async function settled(tid = id) {
  for (let n = 0; n < 100; n += 1) {
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

it("holds the illustrator slot when close is unconfirmed and does not start another native export", async () => {
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
    runUnfoldedNative: async () => { calls += 1; return { code: 8, stdout: "", stderr: "", timedOut: false }; },
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
