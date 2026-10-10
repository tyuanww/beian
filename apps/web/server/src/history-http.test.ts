import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-history-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { deleteTask, saveTask } = await import("./tasks.js");
const { saveMockup } = await import("./mockup.js");
const {
  compressionOutputPath,
  createQueuedCompression,
  newCompressionId,
  readCompressionBatch,
  saveCompressionBatch,
} = await import("./compressionStore.js");
const { HISTORY_SEGMENT_SIZE, noteHistoryUploadId } = await import("./historyIndex.js");

function auth(openId: string, name: string, role: "admin" | "reviewer" | "viewer" = "reviewer") {
  return { authorization: `Bearer ${issueSessionForTest(name, role, openId).token}` };
}

function indexPath(): string {
  return join(DATA_DIR, "history", "index.json");
}

function readIndex(): { trusted: boolean; records: unknown[]; scan: { cursor: string } | null } {
  return JSON.parse(readFileSync(indexPath(), "utf8")) as { trusted: boolean; records: unknown[]; scan: { cursor: string } | null };
}

async function history(headers?: Record<string, string>, query = ""): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await app.request(`/api/history${query ? `?${query}` : ""}`, headers ? { headers } : undefined);
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function untilReady(headers: Record<string, string>, query = ""): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  let last = await history(headers, query);
  for (let step = 0; step < 80 && last.status === 503; step += 1) {
    last = await history(headers, query);
  }
  return last;
}

function q(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  return search.toString();
}

describe("unified history", { concurrency: false }, () => {
  const reviewer = auth("ou_a", "甲", "reviewer");
  const other = auth("ou_b", "甲", "reviewer");
  const admin = auth("ou_admin", "管理员", "admin");
  const viewer = auth("ou_view", "只读", "viewer");
  const secretOwner = auth("ou_secret", "秘密", "reviewer");

  it("rejects anonymous history and a corrupt index without an empty list", async () => {
    const anon = await history();
    assert.equal(anon.status, 401);
    assert.equal(anon.body.detail, "未登录");
    assert.equal("code" in anon.body, false);
    assert.equal("items" in anon.body, false);

    mkdirSync(dirname(indexPath()), { recursive: true });
    writeFileSync(indexPath(), "{");
    const broken = await history(reviewer);
    assert.equal(broken.status, 503);
    assert.equal(broken.body.code, "history_index_corrupt");
    assert.equal(broken.body.detail, "历史索引已损坏");
    assert.equal("items" in broken.body, false);
    assert.equal("total" in broken.body, false);
    const ready = await history(reviewer);
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body.items, []);
    assert.equal(ready.body.total, 0);
  });

  it("rejects invalid filters and keeps a missing index unavailable", async () => {
    rmSync(indexPath(), { force: true });
    const missing = await history(reviewer, q({ limit: 10 }));
    assert.equal(missing.status, 503);
    assert.equal(missing.body.code, "history_index_unavailable");
    assert.equal("items" in missing.body, false);
    const ready = await untilReady(reviewer);
    assert.equal(ready.status, 200);

    const cases = [
      "limit=0",
      "limit=101",
      "type=nope",
      "type=review&status=failed",
      "type=review&status=unmet_target",
      "date_from=2026-10-10&date_to=2026-10-09&tz=%2B08:00",
      "date_from=2026-02-31&tz=Z",
      "date_from=2026-10-09",
      "tz=%2B08",
      "cursor=",
      "extra=1",
    ];
    for (const query of cases) {
      const bad = await history(reviewer, query);
      assert.equal(bad.status, 400, query);
      assert.equal(bad.body.code, "history_query_invalid");
      assert.equal("items" in bad.body, false);
    }
  });

  it("filters by permission before keyword, total, and facets", async () => {
    await untilReady(reviewer);
    saveTask({
      id: "aaaaaaa00001",
      title: "甲的批次",
      product_name: "甲的品名",
      type: "excel_pdf",
      status: "pending_review",
      created_at: "2026-10-09T02:00:00.000Z",
      owner: "ou_a",
      created_by: "甲",
    });
    saveTask({
      id: "aaaaaaa00002",
      title: "乙的批次",
      product_name: "乙的品名",
      type: "excel_pdf",
      status: "completed",
      created_at: "2026-10-08T15:00:00.000Z",
      owner: "ou_b",
      created_by: "甲",
    });
    saveTask({
      id: "aaaaaaa00003",
      title: "次日批次",
      product_name: "次日品名",
      type: "excel_pdf",
      status: "in_review",
      created_at: "2026-10-09T16:00:00.000Z",
      owner: "ou_a",
      created_by: "甲",
    });
    saveMockup({
      id: "aaaaaaa00004",
      status: "failed",
      title: "打样批次叶子",
      created_at: "2026-10-09T03:00:00.000Z",
      files: [{ key: "src", name: "子文件-打样叶子.ai" }],
      owner: "ou_a",
      created_by: "甲",
    } as never);
    const receiptId = "aaaaaaa00005";
    const receiptDir = join(DATA_DIR, "uploads", "receipts");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(join(receiptDir, `${receiptId}.json`), JSON.stringify({
      id: receiptId,
      owner: "ou_secret",
      created_at: new Date().toISOString(),
      product_name: "隐藏上传品",
      files: [{ field: "pdf", name: "secret-leaf-upload.pdf", path: "hidden", bytes: 4 }],
    }));
    noteHistoryUploadId(receiptId);

    const compressionId = newCompressionId();
    createQueuedCompression({
      id: compressionId,
      title: "压缩批次叶子",
      ownerId: "ou_a",
      createdBy: "甲",
      receiptId: "aaaaaaa00006",
      files: [
        { id: "asset1", name: "子文件-压缩叶子.jpg", media_type: "image/jpeg", bytes: 4, sha256: "ab".repeat(32) },
        { id: "asset2", name: "失败叶子.jpg", media_type: "image/jpeg", bytes: 4, sha256: "cd".repeat(32) },
      ],
      policyFingerprint: "fp",
      toolGeneration: "gen",
    });
    const batch = readCompressionBatch(compressionId);
    assert.ok(batch);
    batch.files[0].status = "succeeded";
    batch.files[0].output_bytes = 4;
    batch.files[1].status = "unmet_target";
    batch.files[1].reason = "unmet_target";
    batch.files[1].output_bytes = null;
    const output = compressionOutputPath(compressionId, "asset1");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, Buffer.from("jpeg"));
    saveCompressionBatch(batch);

    const adminAll = await history(admin);
    assert.equal(adminAll.status, 200);
    assert.equal(adminAll.text.includes("secret-leaf-upload.pdf"), false);
    assert.equal(adminAll.text.includes("隐藏上传品"), false);
    const adminItems = adminAll.body.items as Array<Record<string, unknown>>;
    assert.equal(adminItems.some((item) => item.id === "aaaaaaa00001"), true);
    assert.equal(adminItems.some((item) => item.id === "aaaaaaa00002"), true);
    assert.equal((adminAll.body.facets as { type: { upload: number } }).type.upload, 0);

    const ownerUpload = await history(secretOwner, q({ q: "secret-leaf-upload" }));
    assert.equal(ownerUpload.status, 200);
    assert.equal(ownerUpload.body.total, 1);
    const uploadItem = (ownerUpload.body.items as Array<Record<string, unknown>>)[0];
    assert.equal(uploadItem.type, "upload");
    assert.equal(uploadItem.visibility, "upload_owner");
    assert.equal(uploadItem.creator_id, "ou_secret");
    assert.deepEqual(uploadItem.matched_names, ["secret-leaf-upload.pdf"]);
    assert.equal("href" in uploadItem, false);
    assert.equal(JSON.stringify(uploadItem).includes("hidden"), false);
    const adminSecret = await history(admin, q({ q: "secret-leaf-upload" }));
    assert.equal(adminSecret.body.total, 0);
    assert.deepEqual(adminSecret.body.items, []);
    assert.equal((adminSecret.body.facets as { type: { upload: number } }).type.upload, 0);

    const stranger = await history(other, q({ q: "甲的品名" }));
    assert.equal(stranger.body.total, 0);
    const sameName = await history(other, q({ creator: "甲", type: "review" }));
    assert.equal(sameName.body.total, 1);
    assert.equal((sameName.body.items as Array<{ id: string }>)[0].id, "aaaaaaa00002");
    const adminNamed = await history(admin, q({ creator: "甲", type: "review" }));
    assert.equal(adminNamed.body.total, 3);

    const day = await history(reviewer, q({ type: "review", date_from: "2026-10-09", date_to: "2026-10-09", tz: "+08:00" }));
    const dayIds = (day.body.items as Array<{ id: string }>).map((item) => item.id).sort();
    assert.deepEqual(dayIds, ["aaaaaaa00001"]);

    const failed = await history(viewer, q({ status: "failed" }));
    assert.equal((failed.body.items as Array<{ id: string }>).some((item) => item.id === "aaaaaaa00004"), true);
    assert.equal((failed.body.items as Array<{ type: string }>).every((item) => item.type !== "compression"), true);
    const partial = await history(viewer, q({ status: "partial" }));
    assert.deepEqual((partial.body.items as Array<{ id: string; type: string }>).map((item) => item.type), ["compression"]);
    assert.equal((partial.body.items as Array<{ id: string }>)[0].id, compressionId);
    const unmet = await history(viewer, q({ type: "compression", status: "unmet_target" }));
    assert.equal(unmet.status, 200);
    assert.equal(unmet.body.total, 1);
    assert.equal((unmet.body.items as Array<{ status: string }>)[0].status, "partial");
    assert.equal((unmet.body.facets as { status: { unmet_target: number } }).status.unmet_target, 1);
    assert.equal(unmet.text.includes("has_unmet_target"), false);
    const viewerReview = await history(viewer, q({ type: "review", q: "甲的品名" }));
    assert.equal(viewerReview.body.total, 0);
    const child = await history(viewer, q({ q: "子文件-打样叶子" }));
    assert.equal(child.body.total, 1);
    assert.equal((child.body.items as Array<{ title: string; matched_names: string[] }>)[0].title, "打样批次叶子");
    const batchName = await history(viewer, q({ q: "压缩批次叶子" }));
    assert.equal(batchName.body.total, 1);

    const detail = await app.request(`/api/compressions/${compressionId}`, { headers: viewer });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { status: string; files: Array<{ key: string | null; status: string }> };
    assert.equal(detailBody.status, "partial");
    const file = await app.request(`/api/compressions/${compressionId}/files/file-asset1`, { headers: viewer });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "jpeg");
    const zip = await app.request(`/api/compressions/${compressionId}/zip`, { headers: viewer });
    assert.equal(zip.status, 200);
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(zipBytes.subarray(0, 2).toString(), "PK");
    assert.equal(zipBytes.includes(Buffer.from("子文件-压缩叶子.jpg")), true);
    assert.equal(zipBytes.includes(Buffer.from("失败叶子.jpg")), false);

    const page = await history(reviewer, q({ limit: 1, type: "review" }));
    assert.equal(page.body.total, 2);
    const cursor = String(page.body.next_cursor);
    const drifted = await history(reviewer, q({ limit: 1, type: "review", q: "别的", cursor }));
    assert.equal(drifted.status, 400);
    const stolen = await history(other, q({ limit: 1, type: "review", cursor }));
    assert.equal(stolen.status, 400);
    const page2 = await history(reviewer, q({ limit: 1, type: "review", cursor }));
    assert.equal(page2.status, 200);
    assert.notEqual((page2.body.items as Array<{ id: string }>)[0].id, (page.body.items as Array<{ id: string }>)[0].id);

    const freshId = "aaaaaaa00007";
    saveTask({
      id: freshId,
      title: "边界之后",
      product_name: "边界之后品",
      type: "excel_pdf",
      status: "completed",
      created_at: "2026-10-12T00:00:00.000Z",
      owner: "ou_a",
      created_by: "甲",
    });
    const held = await history(reviewer, q({ limit: 1, type: "review", cursor }));
    assert.equal((held.body.items as Array<{ id: string }>).some((item) => item.id === freshId), false);
    const rebound = await history(reviewer, q({ limit: 1, type: "review" }));
    assert.equal((rebound.body.items as Array<{ id: string }>)[0].id, freshId);

    const taskPath = join(DATA_DIR, "tasks", "aaaaaaa00001.json");
    const original = readFileSync(taskPath, "utf8");
    writeFileSync(taskPath, original.replace("甲的品名", "不应被重扫见到"));
    const missed = await history(reviewer, q({ q: "不应被重扫见到" }));
    assert.equal(missed.status, 200);
    assert.equal(missed.body.total, 0);
    writeFileSync(taskPath, original);
    saveTask({
      id: "aaaaaaa00008",
      title: "钩子新增",
      product_name: "钩子品名",
      type: "excel_pdf",
      status: "completed",
      created_at: "2026-10-11T00:00:00.000Z",
      owner: "ou_a",
      created_by: "甲",
    });
    const hooked = await history(reviewer, q({ q: "钩子品名" }));
    assert.equal(hooked.status, 200);
    assert.equal(hooked.body.total, 1);
    deleteTask("aaaaaaa00008");
    const gone = await history(reviewer, q({ q: "钩子品名" }));
    assert.equal(gone.status, 200);
    assert.equal(gone.body.total, 0);
  });

  it("pages 1000 synthetic reviews without rereading the whole source set", async () => {
    writeReviews("b", 1000, "ou_1k", Date.parse("2021-01-01T00:00:00.000Z"));
    rmSync(indexPath(), { force: true });
    const headers = auth("ou_1k", "批量", "reviewer");
    const first = await history(headers, q({ creator: "ou_1k" }));
    assert.equal(first.status, 503);
    assert.equal("items" in first.body, false);
    const staged = readIndex();
    assert.equal(staged.trusted, false);
    assert.equal(staged.records.length, HISTORY_SEGMENT_SIZE);
    let steps = 1;
    let ready = first;
    while (ready.status === 503 && steps < 40) {
      ready = await history(headers, q({ creator: "ou_1k" }));
      steps += 1;
    }
    assert.equal(ready.status, 200);
    assert.equal(ready.body.total, 1000);
    assert.equal((ready.body.items as unknown[]).length, 50);

    const wide = await history(headers, q({ creator: "ou_1k", limit: 100 }));
    assert.equal((wide.body.items as unknown[]).length, 100);
    const ids = await collectIds(headers, { creator: "ou_1k", limit: 100 });
    assert.equal(ids.length, 1000);
    assert.equal(new Set(ids).size, 1000);
    assert.equal(ids[0], "b000000003e7");
    assert.equal(ids[ids.length - 1], "b00000000000");
    assert.equal(ids.slice(0, 100).includes("b00000000000"), false);
    const named = await history(headers, q({ creator: "ou_1k", q: "跨页品名-b" }));
    assert.equal(named.body.total, 1);
    assert.equal((named.body.items as Array<{ id: string; product_name: string }>)[0].id, "b00000000000");
    assert.equal((named.body.items as Array<{ product_name: string }>)[0].product_name, "跨页品名-b");
  });

  it("pages 10000 synthetic summaries and finds a child name off the first page", async () => {
    writeReviews("c", 10000, "ou_10k", Date.parse("2020-01-01T00:00:00.000Z"));
    const mockupId = "d00000000001";
    mkdirSync(join(DATA_DIR, "mockups", mockupId), { recursive: true });
    writeFileSync(join(DATA_DIR, "mockups", mockupId, "job.json"), JSON.stringify({
      id: mockupId,
      status: "done",
      title: "跨页打样",
      created_at: "2019-01-01T00:00:00.000Z",
      files: [{ key: "src", name: "子文件-跨页叶子.ai" }],
      owner: "ou_leaf",
      created_by: "叶子",
    }));
    writeFileSync(indexPath(), "{\"schema_version\":1,");
    const headers = auth("ou_10k", "万条", "admin");
    const first = await history(headers, q({ limit: 100 }));
    assert.equal(first.status, 503);
    assert.equal(first.body.code, "history_index_corrupt");
    assert.equal("items" in first.body, false);
    const staged = readIndex();
    assert.equal(staged.trusted, false);
    assert.ok(staged.records.length <= HISTORY_SEGMENT_SIZE);
    assert.equal(staged.records.length, HISTORY_SEGMENT_SIZE);
    let steps = 1;
    let ready = first;
    while (ready.status === 503 && steps < 90) {
      ready = await history(headers, q({ limit: 100 }));
      steps += 1;
      if (ready.status === 503) assert.equal("items" in ready.body, false);
    }
    assert.equal(ready.status, 200, `steps=${steps}`);
    assert.ok(steps >= 51);
    const bulk = await history(headers, q({ creator: "ou_10k", limit: 100 }));
    assert.equal(bulk.body.total, 10000);
    const ids = await collectIds(headers, { creator: "ou_10k", limit: 100 });
    assert.equal(ids.length, 10000);
    assert.equal(new Set(ids).size, 10000);
    assert.equal(ids[ids.length - 1], "c00000000000");
    assert.equal(ids.slice(0, 100).includes("c00000000000"), false);
    const oldest = await history(headers, q({ q: "跨页品名-c" }));
    assert.equal(oldest.body.total, 1);
    assert.equal((oldest.body.items as Array<{ id: string }>)[0].id, "c00000000000");

    const leaf = await history(headers, q({ q: "子文件-跨页叶子" }));
    assert.equal(leaf.body.total, 1);
    const leafItem = (leaf.body.items as Array<Record<string, unknown>>)[0];
    assert.equal(leafItem.id, mockupId);
    assert.equal(leafItem.type, "mockup");
    assert.deepEqual(leafItem.matched_names, ["子文件-跨页叶子.ai"]);
    assert.equal("href" in leafItem, false);
    const firstPage = await history(headers, q({ limit: 100 }));
    assert.equal((firstPage.body.items as Array<{ id: string }>).some((item) => item.id === mockupId), false);
    const all = await collectIds(headers, { limit: 100 });
    assert.equal(all.filter((id) => id === mockupId).length, 1);
    assert.ok(all.indexOf(mockupId) >= 100);
  });
});

function writeReviews(prefix: string, count: number, owner: string, baseMs: number): void {
  const dir = join(DATA_DIR, "tasks");
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}${index.toString(16).padStart(11, "0")}`;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id,
      title: `批次-${id}`,
      product_name: index === 0 ? `跨页品名-${prefix}` : `品-${id}`,
      type: "excel_pdf",
      status: "completed",
      created_at: new Date(baseMs + index * 1000).toISOString(),
      owner,
      created_by: "批量",
    }));
  }
}

async function collectIds(headers: Record<string, string>, params: Record<string, string | number>): Promise<string[]> {
  const ids: string[] = [];
  let cursor = "";
  let previous = "";
  for (let page = 0; page < 200; page += 1) {
    const query = q({ ...params, ...(cursor ? { cursor } : {}) });
    const res = await app.request(`/api/history?${query}`, { headers });
    assert.equal(res.status, 200);
    const body = await res.json() as { items: Array<{ id: string; created_at: string }>; next_cursor: string | null };
    assert.ok(body.items.length > 0);
    if (previous) assert.ok(body.items[0].created_at <= previous);
    previous = body.items[body.items.length - 1].created_at;
    ids.push(...body.items.map((item) => item.id));
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}
