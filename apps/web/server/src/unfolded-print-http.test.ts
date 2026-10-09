import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-unfolded-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { DATA_DIR, PYTHON } = await import("./config.js");
const { readMockupFromDisk, saveMockup } = await import("./mockup.js");
const { resetJobsTestHooks, setJobsTestHooks } = await import("./jobs.js");
const { runUnfoldedPublish } = await import("./workers.js");

const owner = "ou_unfolded_http";
const id = "ac00ac00ac01";
const png = Buffer.from("89504e470d0a1a0a", "hex");
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
      { id: "rule", role: "decoration", panel_id: "front", bounds_mm: [112, 82, 145, 82.2] },
      { id: "knife", role: "cut", panel_id: "front", bounds_mm: [100, 30, 150, 90] },
    ],
  },
};

function seed() {
  const dir = join(DATA_DIR, "mockups", id);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "unfolded-source.json"), JSON.stringify(net));
  saveMockup({
    id, status: "done", job_kind: "mockup", job_status: "succeeded", created_at: "2026-10-09T00:00:00Z",
    owner, files: [],
  });
  return dir;
}

function session(role: "reviewer" | "viewer" = "reviewer") {
  return issueSessionForTest("籽烨", role, owner);
}

afterEach(() => {
  resetJobsTestHooks();
  rmSync(join(DATA_DIR, "mockups"), { recursive: true, force: true });
});

describe("unfolded print http", () => {
  it("returns the public contract and a whitelist pdf with physical millimetres", async () => {
    const dir = seed();
    setJobsTestHooks({ runUnfoldedPublish });
    const token = session().token;
    const created = await app.request(`/api/mockups/${id}/unfolded-print`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(created.status, 202);
    const queued = await created.json() as { unfolded_print: { status: string; file_key?: string } };
    assert.equal(queued.unfolded_print.status, "queued");
    assert.equal(queued.unfolded_print.file_key, undefined);
    let ready: { unfolded_print: { status: string; file_key?: string; width_mm?: number; height_mm?: number; reason?: string } } | undefined;
    for (let n = 0; n < 100; n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const view = await app.request(`/api/mockups/${id}`, { headers: { authorization: `Bearer ${token}` } });
      ready = await view.json() as typeof ready;
      if (ready?.unfolded_print.status === "ready" || ready?.unfolded_print.status === "failed") break;
    }
    assert.equal(ready?.unfolded_print.status, "ready");
    assert.equal(ready?.unfolded_print.file_key, "unfolded_print");
    assert.equal(ready?.unfolded_print.width_mm, 180);
    assert.equal(ready?.unfolded_print.height_mm, 140);
    const listed = await app.request("/api/mockups", { headers: { authorization: `Bearer ${token}` } });
    const rows = await listed.json() as Array<Record<string, unknown>>;
    assert.equal(rows.some((row) => "unfolded_print" in row), false);
    const missing = await app.request(`/api/mockups/${id}/files/not_a_file`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 404);
    const pdf = await app.request(`/api/mockups/${id}/files/unfolded_print`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const measured = join(dir, "measured.pdf");
    writeFileSync(measured, bytes);
    const size = execFileSync(PYTHON, ["-c", "import pymupdf,sys; d=pymupdf.open(sys.argv[1]); p=d[0]; print(round(p.mediabox.width*25.4/72,3), round(p.mediabox.height*25.4/72,3))", measured], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
    assert.equal(size[0], 180);
    assert.equal(size[1], 140);
    const text = JSON.stringify(ready);
    assert.equal(text.includes(DATA_DIR), false);
    assert.equal(text.includes("source_sha256"), false);
    assert.equal(text.includes("worker_pid"), false);
  });

  it("serves six panel pngs as a zip and refuses a partial set", async () => {
    const dir = seed();
    const token = session().token;
    for (const face of ["front", "back", "left", "right", "top"]) writeFileSync(join(dir, "assets", `panel_${face}.png`), png);
    const partial = await app.request(`/api/mockups/${id}`, { headers: { authorization: `Bearer ${token}` } });
    const partialBody = await partial.json() as { print_faces_zip: { status: string; reason?: string; file_key?: string } };
    assert.equal(partialBody.print_faces_zip.status, "incomplete");
    assert.equal(partialBody.print_faces_zip.reason, "faces_incomplete");
    assert.equal(partialBody.print_faces_zip.file_key, undefined);
    const denied = await app.request(`/api/mockups/${id}/files/print_faces_zip`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(denied.status, 404);
    writeFileSync(join(dir, "assets", "panel_bottom.png"), png);
    const zip = await app.request(`/api/mockups/${id}/files/print_faces_zip`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.equal(bytes.includes(Buffer.from("unfolded-print.pdf")), false);
    assert.equal(bytes.includes(Buffer.from("panel_front.png")), true);
    assert.equal(bytes.includes(Buffer.from("panel_glue.png")), false);
  });

  it("refuses viewers and keeps a failed reason visible", async () => {
    seed();
    const viewer = issueSessionForTest("只看", "viewer", "ou_unfolded_view");
    const denied = await app.request(`/api/mockups/${id}/unfolded-print`, { method: "POST", headers: { authorization: `Bearer ${viewer.token}` } });
    assert.equal(denied.status, 403);
    rmSync(join(DATA_DIR, "mockups", id, "unfolded-source.json"));
    writeFileSync(join(DATA_DIR, "mockups", id, "source.ai"), "synthetic");
    const job = readMockupFromDisk(id)!;
    job.source_path = join(DATA_DIR, "mockups", id, "source.ai");
    saveMockup(job);
    const token = session().token;
    const failed = await app.request(`/api/mockups/${id}/unfolded-print`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(failed.status, 409);
    const body = await failed.json() as { reason: string; unfolded_print: { status: string; reason?: string } };
    assert.equal(body.reason, "geometry_incomplete");
    assert.equal(body.unfolded_print.status, "failed");
    assert.equal(body.unfolded_print.reason, "geometry_incomplete");
    const again = await app.request(`/api/mockups/${id}`, { headers: { authorization: `Bearer ${token}` } });
    const view = await again.json() as { unfolded_print: { status: string; reason?: string; file_key?: string } };
    assert.equal(view.unfolded_print.reason, "geometry_incomplete");
    assert.equal(view.unfolded_print.file_key, undefined);
  });
});
