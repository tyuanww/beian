import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-compression-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { RELEASE_CONTROL_TEST_TOKEN } = await import("./releaseAdmission.js");
const { compressionPolicyFingerprint } = await import("./compressionPolicy.js");
const { assessCapabilityNow, setCompressionCapabilityForTest } = await import("./compressionProbe.js");
const { setCompressionExecutorForTest } = await import("./compressionExecute.js");
const { compressionActiveLeases, compressionSettled, setCompressionAttemptTimeoutForTest, setCompressionClockForTest } = await import("./compressionRuntime.js");
const { compressionOutputPath, readCompressionBatch } = await import("./compressionStore.js");
const { loadReceipt, stageBuffers } = await import("./uploads.js");
const { setCompressionStartFaultForTest } = await import("./compressionApi.js");

function ready(toolGeneration = "test-gen") {
  return {
    budget: "enforced" as const,
    mechanism: "test",
    toolsReady: true,
    missing: [],
    diskFreeBytes: 8 * 1024 * 1024 * 1024,
    toolGeneration,
    policyFingerprint: compressionPolicyFingerprint(),
    versions: { sharp: "0-test", qpdf: "qpdf-test", java: "java-test", pdfbox: "pdfbox-test" },
  };
}

function auth(openId = "ou_compress", name = "魏炜", role: "admin" | "reviewer" | "viewer" = "reviewer") {
  return { authorization: `Bearer ${issueSessionForTest(name, role, openId).token}` };
}

function jpeg(text = "jpg"): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(text)]);
}

function pdf(text = "pdf"): Buffer {
  return Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);
}

function passthrough() {
  return Promise.resolve({ status: "passthrough" as const, reason: null, publish: "copy_source" as const });
}

beforeEach(() => {
  setCompressionCapabilityForTest(ready());
  setCompressionExecutorForTest(passthrough);
  setCompressionAttemptTimeoutForTest(null);
  setCompressionClockForTest(null);
  setCompressionStartFaultForTest(null);
});

async function stage(owner: string, parts: { field: string; name: string; buf: Buffer }[]) {
  return stageBuffers(owner, parts);
}

type PublicBatch = {
  id: string;
  status: string;
  revision: number;
  creator_id: string;
  files: Array<{
    id: string;
    status: string;
    output_bytes: number | null;
    key: string | null;
    target_bytes: number | null;
    reason: string | null;
    can_retry: boolean;
  }>;
};

async function start(owner: string, receipt: string, headers = auth(owner)) {
  const response = await app.request("/api/compressions/start", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ receipt }),
  });
  const body = await response.json() as PublicBatch;
  await compressionSettled();
  return { response, body };
}

async function fetchBatch(id: string, owner: string): Promise<PublicBatch> {
  const response = await app.request(`/api/compressions/${id}`, { headers: auth(owner) });
  assert.equal(response.status, 200);
  return await response.json() as PublicBatch;
}

describe("compression http", () => {
  it("uploads a compression purpose and starts an idempotent batch", async () => {
    const owner = "ou_purpose";
    const created = await app.request("/api/uploads/sessions", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({
        client_upload_id: "compress-purpose-1",
        purpose: "compression",
        files: [{ field: "asset1", name: "盒.jpg", bytes: jpeg().length }],
      }),
    });
    assert.equal(created.status, 200);
    const upload = (await created.json() as { upload: { id: string; kind: string } }).upload;
    assert.equal(upload.kind, "compression");
    const put = await app.request(`/api/uploads/sessions/${upload.id}/files/asset1`, {
      method: "PUT",
      headers: {
        ...auth(owner),
        "content-type": "application/octet-stream",
        "x-upload-offset": "0",
        "x-upload-sha256": createHash("sha256").update(jpeg()).digest("hex"),
      },
      body: Uint8Array.from(jpeg()).buffer,
    });
    assert.equal(put.status, 200);
    const completed = await app.request(`/api/uploads/sessions/${upload.id}/complete`, {
      method: "POST",
      headers: auth(owner),
    });
    assert.equal(completed.status, 200);
    const first = await start(owner, upload.id);
    assert.equal(first.response.status, 202);
    assert.equal(first.body.status, "queued");
    const done = await fetchBatch(first.body.id, owner);
    assert.equal(done.status, "done");
    assert.equal(done.files[0].target_bytes, null);
    const again = await app.request("/api/compressions/start", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ receipt: upload.id }),
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json() as { id: string }).id, first.body.id);
    const listed = await app.request("/api/compressions", { headers: auth("ou_other", "其他人", "reviewer") });
    assert.equal(listed.status, 200);
    const items = (await listed.json() as { items: Array<{ id: string; creator_id: string }> }).items;
    assert.equal(items.some((item) => item.id === first.body.id && item.creator_id === owner), true);
  });

  it("rejects viewers, compare receipts, and same-name non-owners", async () => {
    const owner = "ou_owner_retry";
    const receipt = await stage(owner, [{ field: "asset1", name: "a.pdf", buf: pdf() }]);
    setCompressionExecutorForTest(async () => ({ status: "unmet_target", reason: "unmet_target", publish: "none" }));
    const viewer = await app.request("/api/compressions/start", {
      method: "POST",
      headers: { ...auth(owner, "魏炜", "viewer"), "content-type": "application/json" },
      body: JSON.stringify({ receipt: receipt.id }),
    });
    assert.equal(viewer.status, 403);
    const started = await start(owner, receipt.id);
    assert.equal(started.response.status, 202);
    const settled = await fetchBatch(started.body.id, owner);
    const file = settled.files[0];
    assert.equal(file.output_bytes, null);
    assert.equal(file.target_bytes, 10_000_000);
    assert.equal(file.can_retry, false);
    const stranger = await app.request(`/api/compressions/${started.body.id}/retry`, {
      method: "POST",
      headers: { ...auth("ou_same_name", "魏炜", "reviewer"), "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: settled.revision }),
    });
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json() as { code: string }).code, "compression_forbidden");
    const compare = await stage(owner, [
      { field: "excel", name: "a.xlsx", buf: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
      { field: "pdf", name: "a.pdf", buf: pdf() },
    ]);
    const wrong = await app.request("/api/compressions/start", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ receipt: compare.id }),
    });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json() as { code: string }).code, "compression_receipt_invalid");
    assert.ok(loadReceipt(compare.id, owner));
  });

  it("retries only after capability changes and replays the same request", async () => {
    const owner = "ou_retry";
    const receipt = await stage(owner, [{ field: "asset1", name: "a.pdf", buf: pdf("retry") }]);
    setCompressionExecutorForTest(async () => ({ status: "unmet_target", reason: "unmet_target", publish: "none" }));
    const started = await start(owner, receipt.id);
    const settled = await fetchBatch(started.body.id, owner);
    const denied = await app.request(`/api/compressions/${started.body.id}/retry`, {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: settled.revision }),
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json() as { code: string; reason: string }).reason, "capability_unchanged");
    setCompressionCapabilityForTest(ready("test-gen-2"));
    const accepted = await app.request(`/api/compressions/${started.body.id}/retry`, {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: settled.revision }),
    });
    assert.equal(accepted.status, 202);
    await accepted.json();
    await compressionSettled();
    const replay = await app.request(`/api/compressions/${started.body.id}/retry`, {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: settled.revision }),
    });
    assert.equal(replay.status, 200);
    const stored = readCompressionBatch(started.body.id);
    assert.equal(stored?.retry_log.length, 1);
    assert.equal(stored?.attempt, 2);
    assert.equal(stored?.files[0].tool_generation, "test-gen-2");
    assert.equal(stored?.files[0].policy_snapshot?.pdf_target_bytes, 10_000_000);
    setCompressionClockForTest(() => Date.parse(stored?.files[0].last_retry_at || "") + 31_000);
    const admin = await app.request(`/api/compressions/${started.body.id}/retry`, {
      method: "POST",
      headers: { ...auth("ou_admin", "管理员", "admin"), "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: stored?.revision, file_ids: ["asset1"] }),
    });
    assert.equal(admin.status, 409);
    assert.equal((await admin.json() as { reason: string }).reason, "capability_unchanged");
    setCompressionCapabilityForTest(ready("test-gen-3"));
    const changed = await app.request(`/api/compressions/${started.body.id}/retry`, {
      method: "POST",
      headers: { ...auth("ou_admin", "管理员", "admin"), "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: stored?.revision, file_ids: ["asset1"] }),
    });
    assert.equal(changed.status, 202);
    await compressionSettled();
  });

  it("downloads a published file, zips only successes, and drains a lease before delete", async () => {
    const owner = "ou_zip";
    const source = jpeg("keep");
    const receipt = await stage(owner, [
      { field: "asset1", name: "keep.jpg", buf: source },
      { field: "asset2", name: "big.pdf", buf: pdf("big") },
    ]);
    setCompressionExecutorForTest(async (request) => {
      if (request.file.media_type === "application/pdf") {
        mkdirSync(dirname(request.outputPath), { recursive: true });
        writeFileSync(request.outputPath, Buffer.alloc(10_000_000, 9));
        return { status: "succeeded", reason: null, publish: "output" };
      }
      mkdirSync(dirname(request.outputPath), { recursive: true });
      writeFileSync(request.outputPath, Buffer.concat([source, Buffer.from("extra")]));
      return { status: "succeeded", reason: null, publish: "output" };
    });
    const started = await start(owner, receipt.id);
    const settled = await fetchBatch(started.body.id, owner);
    assert.equal(settled.status, "partial");
    const files = settled.files;
    const image = files.find((file) => file.id === "asset1");
    const document = files.find((file) => file.id === "asset2");
    assert.equal(image?.status, "passthrough");
    assert.equal(image?.output_bytes, source.length);
    assert.equal(document?.status, "unmet_target");
    assert.equal(document?.output_bytes, null);
    assert.equal(document?.key, null);
    const downloaded = await app.request(`/api/compressions/${started.body.id}/files/${image?.key}`, { headers: auth(owner) });
    assert.equal(downloaded.status, 200);
    assert.equal(compressionActiveLeases().length, 1);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), source);
    assert.equal(compressionActiveLeases().length, 0);
    const zip = await app.request(`/api/compressions/${started.body.id}/zip`, { headers: auth(owner) });
    assert.equal(zip.status, 200);
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(zipBytes.includes(Buffer.from("keep.jpg")), true);
    assert.equal(zipBytes.includes(Buffer.from("big.pdf")), false);
    const held = await app.request(`/api/compressions/${started.body.id}/files/${image?.key}`, { headers: auth(owner) });
    assert.equal(held.status, 200);
    const deleting = await app.request(`/api/compressions/${started.body.id}`, { method: "DELETE", headers: auth(owner) });
    assert.equal(deleting.status, 202);
    assert.equal((await deleting.json() as { status: string }).status, "deleting");
    await held.arrayBuffer();
    const gone = await app.request(`/api/compressions/${started.body.id}`, { headers: auth(owner) });
    assert.equal(gone.status, 404);
    const again = await app.request(`/api/compressions/${started.body.id}`, { method: "DELETE", headers: auth(owner) });
    assert.equal(again.status, 200);
    assert.equal((await again.json() as { already_deleted: boolean }).already_deleted, true);
  });

  it("refuses a missing or size-mismatched durable output before streaming", async () => {
    const owner = "ou_missing_output";
    const receipt = await stage(owner, [{ field: "asset1", name: "missing.jpg", buf: jpeg("missing") }]);
    const started = await start(owner, receipt.id);
    const file = (await fetchBatch(started.body.id, owner)).files[0];
    rmSync(compressionOutputPath(started.body.id, "asset1"), { force: true });
    const single = await app.request(`/api/compressions/${started.body.id}/files/${file.key}`, { headers: auth(owner) });
    assert.equal(single.status, 404);
    assert.equal((await single.json() as { code: string }).code, "compression_file_missing");
    const zip = await app.request(`/api/compressions/${started.body.id}/zip`, { headers: auth(owner) });
    assert.equal(zip.status, 404);
    assert.equal((await zip.json() as { code: string }).code, "compression_file_missing");
  });

  it("does not publish an empty zip or delete a running batch", async () => {
    const owner = "ou_empty";
    const receipt = await stage(owner, [{ field: "asset1", name: "a.pdf", buf: pdf("none") }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setCompressionExecutorForTest(async () => {
      await gate;
      return { status: "unmet_target", reason: "unmet_target", publish: "none" };
    });
    const pending = start(owner, receipt.id);
    let item: { id: string; status: string } | undefined;
    for (let attempt = 0; attempt < 50 && !item; attempt += 1) {
      const running = await app.request("/api/compressions", { headers: auth(owner) });
      item = (await running.json() as { items: Array<{ id: string; status: string; creator_id: string }> }).items.find((row) => row.creator_id === owner && (row.status === "queued" || row.status === "running"));
      if (!item) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(item);
    const removing = await app.request(`/api/compressions/${item.id}`, { method: "DELETE", headers: auth(owner) });
    assert.equal(removing.status, 409);
    assert.equal((await removing.json() as { code: string }).code, "compression_not_terminal");
    release();
    const started = await pending;
    const settled = await fetchBatch(started.body.id, owner);
    assert.equal(settled.status, "failed");
    const zip = await app.request(`/api/compressions/${started.body.id}/zip`, { headers: auth(owner) });
    assert.equal(zip.status, 409);
    assert.equal((await zip.json() as { code: string }).code, "compression_zip_empty");
  });

  it("fails closed before claiming a receipt", async () => {
    const owner = "ou_preflight";
    const receipt = await stage(owner, [{ field: "asset1", name: "a.jpg", buf: jpeg("budget") }]);
    setCompressionCapabilityForTest({ ...ready(), budget: "unavailable" as const, mechanism: "rlimit-unavailable", toolsReady: false });
    const blocked = await app.request("/api/compressions/start", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ receipt: receipt.id }),
    });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json() as { code: string }).code, "platform_budget_unavailable");
    assert.ok(loadReceipt(receipt.id, owner));
    setCompressionCapabilityForTest({ ...ready(), diskFreeBytes: 1 });
    const disk = await app.request("/api/compressions/start", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ receipt: receipt.id }),
    });
    assert.equal(disk.status, 507);
    assert.equal((await disk.json() as { code: string }).code, "disk_space");
    assert.ok(loadReceipt(receipt.id, owner));
    if (process.platform === "darwin") {
      setCompressionCapabilityForTest(null);
      const probed = assessCapabilityNow();
      assert.equal(probed.budget, "unavailable");
      assert.equal(probed.mechanism, "platform-budget-unavailable");
    }
  });

  it("keeps eight receipts startable and rejects work that would exceed the source quota", async () => {
    const owner = "ou_quota";
    const receipts = [];
    for (let index = 0; index < 8; index += 1) {
      receipts.push(await stage(`${owner}`, [{ field: "asset1", name: `q${index}.jpg`, buf: jpeg(String(index)) }]));
    }
    const first = await start(owner, receipts[0].id);
    assert.equal(first.response.status, 202);
    const { createQueuedCompression, newCompressionId, freezeCompressionSources } = await import("./compressionStore.js");
    for (let index = 0; index < 8; index += 1) {
      const id = newCompressionId();
      const frozen = freezeCompressionSources(id, [{
        id: "asset1",
        name: "held.jpg",
        media_type: "image/jpeg",
        path: receipts[1].files[0].path,
      }]);
      const batch = createQueuedCompression({
        id,
        title: `held-${index}`,
        ownerId: owner,
        createdBy: "魏炜",
        receiptId: receipts[1].id,
        files: frozen,
        policyFingerprint: compressionPolicyFingerprint(),
        toolGeneration: "test-gen",
      });
      batch.files[0].input_bytes = 50 * 1024 * 1024;
      const { saveCompressionBatch } = await import("./compressionStore.js");
      saveCompressionBatch(batch);
    }
    const crowded = await app.request("/api/compressions/start", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ receipt: receipts[2].id }),
    });
    assert.equal(crowded.status, 429);
    assert.equal((await crowded.json() as { code: string }).code, "compression_source_quota");
    assert.ok(loadReceipt(receipts[2].id, owner));
  });

  it("refuses new compression while the release drain is open", async () => {
    const owner = "ou_drain";
    const receipt = await stage(owner, [{ field: "asset1", name: "a.jpg", buf: jpeg("drain") }]);
    const entered = await app.request("/api/internal/release/drain", {
      method: "POST",
      headers: {
        "x-beian-release-token": RELEASE_CONTROL_TEST_TOKEN,
        "x-beian-release-lease": "compression-drain-lease-0001",
      },
    });
    assert.equal(entered.status, 200);
    try {
      const blocked = await app.request("/api/compressions/start", {
        method: "POST",
        headers: { ...auth(owner), "content-type": "application/json" },
        body: JSON.stringify({ receipt: receipt.id }),
      });
      assert.equal(blocked.status, 503);
      assert.equal((await blocked.json() as { code: string }).code, "compression_draining");
      assert.ok(loadReceipt(receipt.id, owner));
    } finally {
      await app.request("/api/internal/release/drain", {
        method: "DELETE",
        headers: {
          "x-beian-release-token": RELEASE_CONTROL_TEST_TOKEN,
          "x-beian-release-lease": "compression-drain-lease-0001",
        },
      });
    }
  });

  it("rolls back a receipt when the manifest is not published", async () => {
    const owner = "ou_fault";
    const receipt = await stage(owner, [{ field: "asset1", name: "a.jpg", buf: jpeg("fault") }]);
    setCompressionStartFaultForTest("after-pointer");
    const failed = await app.request("/api/compressions/start", {
      method: "POST",
      headers: { ...auth(owner), "content-type": "application/json" },
      body: JSON.stringify({ receipt: receipt.id }),
    });
    assert.equal(failed.status, 500);
    assert.ok(loadReceipt(receipt.id, owner));
  });

  it("marks an aborted attempt timed out without a byte count", async () => {
    const owner = "ou_timeout";
    const receipt = await stage(owner, [{ field: "asset1", name: "a.jpg", buf: jpeg("time") }]);
    setCompressionAttemptTimeoutForTest(20);
    setCompressionExecutorForTest(async (request) => {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "running", reason: null, publish: "none" };
    });
    const started = await start(owner, receipt.id);
    const file = (await fetchBatch(started.body.id, owner)).files[0];
    assert.equal(file.status, "failed");
    assert.equal(file.reason, "timed_out");
    assert.equal(file.output_bytes, null);
  });
});
