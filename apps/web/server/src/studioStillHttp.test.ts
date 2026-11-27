import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_PUBLIC = "0";
process.env.WB_DEV_DISPLAY_LOGIN = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-studio-still-");

const { app } = await import("./index.js");
const { issueSessionForTest, logout } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { deleteMockup, readMockupFromDisk, saveMockup } = await import("./mockup.js");

const id = "56789abc0001";
const generation = "2026-11-27T01:02:03.000Z";
const token = issueSessionForTest("看图", "viewer", "ou_studio_still").token;
const headers = { authorization: `Bearer ${token}` };
const dir = join(DATA_DIR, "mockups", id);
const base = `/api/mockups/${id}/studio-downloads`;
mkdirSync(dir, { recursive: true });

async function png(width: number, height: number, background: string) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

const files = await Promise.all([
  { key: "white_a", name: "合成_front_right_white.png", data: png(12, 18, "transparent") },
  { key: "white_a_ground", name: "pack_front_right_ground.png", data: png(12, 18, "#000") },
  { key: "white_a_set", name: "pack_front_right_set.png", data: png(12, 18, "#008000") },
  { key: "white_a_card", name: "pack_front_right_card.png", data: png(1000, 1250, "#008000") },
].map(async ({ key, name, data }) => {
  const path = join(dir, name);
  writeFileSync(path, await data);
  return { key, name, path };
}));
saveMockup({
  id, status: "done", job_kind: "mockup", job_status: "succeeded",
  created_at: generation, job_finished_at: generation, files,
});

const selection = {
  file_key: "white_a", generation, backdrop: "white_set", layer: "auto",
  product_light: 1, background_light: 1,
};

function post(payload: Record<string, unknown> = {}, auth: Record<string, string> = headers, path = base) {
  return app.request(path, { method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ ...selection, ...payload }) });
}

async function waitForState(exportId: string, status: string, auth: Record<string, string> = headers, path = base) {
  for (let i = 0; i < 200; i++) {
    const response = await app.request(path, { headers: auth });
    assert.equal(response.status, 200);
    const { items } = await response.json();
    const found = items.find((item: { id: string }) => item.id === exportId);
    if (found?.status === status) return found;
    await delay(10);
  }
  assert.fail(`did not reach ${status}`);
}

test("durable authenticated export dedupes, composes an original-size PNG and resumes byte for byte", async () => {
  assert.equal((await app.request(base)).status, 401);
  assert.equal((await post({}, { authorization: "" })).status, 401);
  const responses = await Promise.all([post(), post()]);
  assert.ok(responses.every(response => response.status === 202 || response.status === 200));
  const [first, duplicate] = await Promise.all(responses.map(response => response.json()));
  assert.equal(first.id, duplicate.id);
  assert.equal(first.created_at, duplicate.created_at);
  const ready = await waitForState(first.id, "ready");
  assert.equal(ready.generation, generation);
  assert.equal((await post()).status, 200);

  const exportResponse = await app.request(ready.download_url, { headers });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get("content-type"), "image/png");
  assert.equal(exportResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(exportResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(exportResponse.headers.get("content-disposition"),
    `attachment; filename="___front_right_white.png"; filename*=UTF-8''${encodeURIComponent("合成_front_right_white.png")}`);
  const bytes = Buffer.from(await exportResponse.arrayBuffer());
  const etag = `"sha256-${createHash("sha256").update(bytes).digest("hex")}"`;
  const length = exportResponse.headers.get("content-length");
  assert.equal(length, String(bytes.length));
  assert.equal(exportResponse.headers.get("etag"), etag);
  const { info, data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels, ...data.subarray(0, 3)], [12, 18, 3, 0, 128, 0]);

  const head = await app.request(ready.download_url, { method: "HEAD", headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(head.headers.get("content-length"), length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const ranged = async (range: string, ifRange = etag) => app.request(ready.download_url, { headers: {
    ...headers, Range: range, "If-Range": ifRange, "Accept-Encoding": "gzip",
  } });
  const initial = await ranged("bytes=0-9");
  const resume = await ranged("bytes=10-");
  assert.equal(initial.status, 206);
  assert.equal(initial.headers.get("content-range"), `bytes 0-9/${length}`);
  assert.equal(initial.headers.get("content-length"), "10");
  assert.equal(resume.status, 206);
  assert.equal(resume.headers.get("content-range"), `bytes 10-${bytes.length - 1}/${length}`);
  assert.equal(resume.headers.get("content-length"), String(bytes.length - 10));
  assert.equal(resume.headers.get("content-encoding"), null);
  assert.deepEqual(Buffer.concat([Buffer.from(await initial.arrayBuffer()), Buffer.from(await resume.arrayBuffer())]), bytes);
  const suffix = await ranged("bytes=-8");
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-8));
  const invalidRange = await ranged(`bytes=${bytes.length}-`);
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-range"), `bytes */${length}`);
  assert.equal(invalidRange.headers.get("content-length"), "0");
  for (const invalidEtag of ['"old"', `W/${etag}`]) {
    const stale = await ranged("bytes=10-", invalidEtag);
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("content-range"), null);
    assert.deepEqual(Buffer.from(await stale.arrayBuffer()), bytes);
  }

  const selectedGround = await post({ layer: "ground" });
  const groundReady = await waitForState((await selectedGround.json()).id, "ready");
  const groundResponse = await app.request(groundReady.download_url, { headers });
  const ground = await sharp(Buffer.from(await groundResponse.arrayBuffer())).raw().toBuffer();
  assert.deepEqual([...ground.subarray(0, 3)], [0, 0, 0]);
});

test("readers recover only their downloads on login and HEAD or range never bypasses ownership", async () => {
  const persisted = await post();
  const ready = await waitForState((await persisted.json()).id, "ready");
  const oauthAgain = issueSessionForTest("重新登录后的显示名", "viewer", "ou_studio_still");
  const sameOwner = { authorization: `Bearer ${oauthAgain.token}` };
  assert.equal((await waitForState(ready.id, "ready", sameOwner)).download_url, ready.download_url);
  for (const role of ["viewer", "admin"] as const) {
    const other = issueSessionForTest("看图", role, `ou_other_${role}`);
    const otherAuth = { authorization: `Bearer ${other.token}` };
    const found = await app.request(base, { headers: otherAuth });
    assert.deepEqual(await found.json(), { items: [] });
    for (const method of ["GET", "HEAD"]) {
      assert.equal((await app.request(ready.download_url, { method, headers: { ...otherAuth, Range: "bytes=0-5" } })).status, 404);
      assert.equal((await app.request(ready.download_url, { method, headers: { Range: "bytes=0-5" } })).status, 401);
    }
  }
  const ownResponse = await app.request(ready.download_url, { headers: sameOwner });
  assert.equal(ownResponse.status, 200);
  await ownResponse.arrayBuffer();
  logout(oauthAgain.token);
  assert.equal((await app.request(ready.download_url, { method: "HEAD", headers: sameOwner })).status, 401);
});

test("loopback display login can restore its own export and carries no public authorization", async () => {
  const host = "127.0.0.1:8787";
  writeFileSync(join(DATA_DIR, "users.json"), JSON.stringify({
    users: [{ name: "本机看图", role: "viewer" }, { name: "本机同事", role: "admin" }],
  }));
  async function login(name: string) {
    const response = await app.request("/api/auth/login", {
      method: "POST", headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ display_name: name }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return { host, cookie };
  }
  const firstLogin = await login("本机看图");
  const accepted = await post({ backdrop: "silver", layer: "none" }, firstLogin);
  assert.equal(accepted.status, 202);
  const ready = await waitForState((await accepted.json()).id, "ready", firstLogin);
  const again = await login("本机看图");
  assert.notEqual(firstLogin.cookie, again.cookie);
  assert.equal((await waitForState(ready.id, "ready", again)).download_url, ready.download_url);
  const other = await login("本机同事");
  assert.deepEqual(await (await app.request(base, { headers: other })).json(), { items: [] });
  assert.equal((await app.request(ready.download_url, { headers: other })).status, 404);
  assert.equal((await app.request(ready.download_url, { headers: { ...again, host: "example.test" } })).status, 401);
});

test("rejects stale legacy source versions and invalid composition parameters", async () => {
  assert.equal((await post({ generation: "older" })).status, 409);
  for (const body of [{ product_light: "2" }, { backdrop: "white", layer: "set" },
    { file_key: "white_a_card" }, { generation_id: "archive", generation }, { owner: "ou_other" }]) {
    assert.equal((await post(body)).status, 400);
  }
});

test("a finished legacy job without a finish or relight timestamp pins its stored creation date", async () => {
  const job = readMockupFromDisk(id);
  assert.ok(job);
  saveMockup({ ...job, job_finished_at: undefined });
  try {
    const requested = await post({ generation: undefined, backdrop: "silver", layer: "none" });
    const started = await requested.json();
    assert.equal(requested.status, 202);
    assert.equal(started.generation, job.created_at);
    await waitForState(started.id, "ready");
    assert.equal((await post({ generation: job.created_at, backdrop: "silver", layer: "none" })).status, 200);
  } finally {
    saveMockup(job);
  }
});

test("a separate server process leaves a durable request and read recovers it after restart", async () => {
  const payload = { ...selection, product_light: 1.1 };
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { writeSync } from "node:fs";
    const { app } = await import("./src/index.ts");
    const { issueSessionForTest } = await import("./src/auth.ts");
    const { token } = issueSessionForTest("合成账号", "viewer", "ou_studio_still");
    const response = await app.request(${JSON.stringify(base)}, {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(payload))},
    });
    writeSync(1, JSON.stringify({ status: response.status, record: await response.json() }));
    process.exit(0);
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const { status, record } = JSON.parse(output);
  assert.equal(status, 202);
  assert.equal(record.status, "preparing");
  const store = join(dir, ".studio-downloads");
  const sidecar = join(store, `${record.id}.json`);
  assert.deepEqual(readdirSync(store).filter(name => name.startsWith(record.id)), [`${record.id}.json`]);
  const ready = await waitForState(record.id, "ready");
  const first = Buffer.from(await (await app.request(ready.download_url, { headers })).arrayBuffer());

  // Emulate the crash point after PNG rename but before publishing ready JSON.
  const metadata = JSON.parse(readFileSync(sidecar, "utf8"));
  writeFileSync(sidecar, JSON.stringify({ ...metadata, status: "preparing" }));
  writeFileSync(join(store, `${record.id}.png.tmp`), "interrupted pending write");
  const recovered = await waitForState(record.id, "ready");
  const recoveredResponse = await app.request(recovered.download_url, { headers });
  assert.equal(recoveredResponse.status, 200);
  assert.deepEqual(Buffer.from(await recoveredResponse.arrayBuffer()), first);
  assert.equal(readdirSync(store).filter(name => name.startsWith(record.id)).length, 2);
});

test("a failed composition retries the same selection and a stale pending export never uses a later source", async () => {
  const job = readMockupFromDisk(id);
  assert.ok(job);
  const later = "2026-11-27T02:02:03.000Z";
  const missingLayer = { layer: "ground", file_key: "white_b" };
  const failed = await post(missingLayer);
  const { id: exportId } = await failed.json();
  await waitForState(exportId, "failed");
  const retry = await post(missingLayer);
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).id, exportId);
  await waitForState(exportId, "failed");

  const priorLink = await waitForState((await (await post()).json()).id, "ready");
  const pending = await post({ background_light: 1.2 });
  const pendingId = (await pending.json()).id;
  saveMockup({ ...job, studio_relit_at: later });
  try {
    await waitForState(pendingId, "failed");
    assert.equal((await post({ background_light: 1.2 })).status, 409);
    const oldFile = await app.request(priorLink.download_url, { headers });
    assert.equal(oldFile.status, 200);
    await oldFile.arrayBuffer();
    const fresh = await post({ generation: later, background_light: 1.2 });
    assert.equal(fresh.status, 202);
    const freshExport = await fresh.json();
    assert.notEqual(freshExport.id, pendingId);
    await waitForState(freshExport.id, "ready");
  } finally {
    saveMockup(job);
  }
});

function copyLegacyJob(newId: string) {
  const job = readMockupFromDisk(id);
  assert.ok(job);
  const root = join(DATA_DIR, "mockups", newId);
  mkdirSync(root, { recursive: true });
  const files = job.files.map(file => {
    const path = join(root, file.name);
    assert.ok(file.path);
    writeFileSync(path, readFileSync(file.path));
    return { ...file, path };
  });
  saveMockup({ ...job, id: newId, files });
  return { root, path: `/api/mockups/${newId}/studio-downloads` };
}

test("capacity never evicts a ready export early and the next access removes expired files", async () => {
  const { root, path } = copyLegacyJob("56789abc0002");
  const records = [];
  for (let index = 0; index < 16; index++) {
    const accepted = await post({ product_light: 0.6 + index / 100 }, headers, path);
    assert.equal(accepted.status, 202);
    const staged = await accepted.json();
    records.push(await waitForState(staged.id, "ready", headers, path));
  }
  const oldest = records[0];
  const refused = await post({ product_light: 1.3 }, headers, path);
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).reason, "studio_download_capacity");
  const previousFile = await app.request(oldest.download_url, { headers });
  assert.equal(previousFile.status, 200);
  await previousFile.arrayBuffer();

  const store = join(root, ".studio-downloads");
  const sidecar = join(store, `${oldest.id}.json`);
  const metadata = JSON.parse(readFileSync(sidecar, "utf8"));
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(sidecar, JSON.stringify({ ...metadata, updated_at: longAgo }));
  const accessible = await app.request(path, { headers });
  const { items } = await accessible.json();
  assert.equal(items.length, 15);
  assert.ok(items.every((item: { id: string }) => item.id !== oldest.id));
  assert.equal((await app.request(oldest.download_url, { headers })).status, 404);
  assert.equal(readdirSync(store).filter(name => name.startsWith(oldest.id)).length, 0);
  const replacement = await post({ product_light: 1.3 }, headers, path);
  assert.equal(replacement.status, 202);
  await waitForState((await replacement.json()).id, "ready", headers, path);
});

test("a queued export does not recreate a deleted mockup directory", async () => {
  const jobId = "56789abc0003";
  const { root, path } = copyLegacyJob(jobId);
  assert.equal((await post({}, headers, path)).status, 202);
  deleteMockup(jobId);
  await delay(20);
  assert.equal(existsSync(root), false);
  assert.equal((await app.request(path, { headers })).status, 404);
});

test("compact card is smaller while its original remains available and validators stay separate", async () => {
  const originalUrl = `/api/mockups/${id}/files/white_a_card`;
  const original = await app.request(originalUrl, { headers });
  const card = await app.request(`${originalUrl}?compact=1`, { headers });
  assert.equal(original.status, 200);
  assert.equal(card.status, 200);
  const originalBytes = Buffer.from(await original.arrayBuffer());
  const compactBytes = Buffer.from(await card.arrayBuffer());
  const { width, height } = await sharp(compactBytes).metadata();
  assert.equal(height, 960);
  assert.equal(width, 768);
  assert.ok(compactBytes.length < originalBytes.length);
  assert.notEqual(card.headers.get("etag"), original.headers.get("etag"));
  const cached = await app.request(`${originalUrl}?compact=1`, {
    headers: { ...headers, "if-none-match": card.headers.get("etag") ?? "" },
  });
  assert.equal(cached.status, 304);
});
