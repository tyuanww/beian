import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ApiError } from "../api.js";
import {
  createStudioDownloadStore,
  studioDownloadBody,
  studioDownloadFor,
  studioDownloadLayer,
  type StudioDownloadBody,
  type StudioDownloadSelection,
} from "./mockupStillDownload.js";

const jobId = "0123456789ab";
const owner = "actor-a";
const exportId = "selection-a";
const href = `/api/mockups/${jobId}/studio-downloads/${exportId}/file`;
const request: StudioDownloadSelection = {
  generation: "g1-legacy-relight-12345678-abcdef12",
  fileKey: "white_b",
  backdrop: "white_set",
  layer: "ground",
  productLight: 1.24,
  backgroundLight: 0.8,
};

function record(status: "preparing" | "failed" | "ready", selection = request) {
  return {
    id: exportId, status, created_at: "2026-11-27T00:21:09.000Z",
    file_key: selection.fileKey, generation: selection.generation, backdrop: selection.backdrop, layer: selection.layer,
    product_light: selection.productLight, background_light: selection.backgroundLight,
    ...(status === "ready" ? { download_url: href } : {}),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => assert.fail("未初始化");
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

type Transport = Parameters<typeof createStudioDownloadStore>[0];

function fixture(t: TestContext, overrides: Partial<Transport>) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const links: string[] = [];
  const postBodies: StudioDownloadBody[] = [];
  const store = createStudioDownloadStore({
    list: overrides.list ?? (async () => ({ items: [] })),
    prepare: async (id, body, signal) => {
      postBodies.push(body);
      return overrides.prepare?.(id, body, signal) ?? record("preparing");
    },
    download: link => { links.push(link); },
  });
  store.setOwner(owner);
  t.after(() => store.setOwner(null));
  return { store, links, postBodies };
}

async function tick(t: TestContext, ms = 0) {
  t.mock.timers.tick(ms);
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("成片请求冻结出图角度、版本、背景、图层和灯光", () => {
  assert.deepEqual(studioDownloadBody(request), {
    file_key: "white_b", generation_id: request.generation, backdrop: "white_set", layer: "ground",
    product_light: 1.24, background_light: 0.8,
  });
  const legacy = "2026-11-27T08:21:09+08:00";
  const legacyBody = studioDownloadBody({ ...request, generation: legacy });
  assert.equal(legacyBody.generation, legacy);
  assert.equal(legacyBody.generation_id, undefined);
  assert.equal(studioDownloadBody({ ...request, generation: "" }).generation, undefined);
});

test("白桌白墙优先冻结已经绘制的图层，未绘制才让服务端选择", () => {
  assert.equal(studioDownloadLayer("white_set", null), "auto");
  assert.equal(studioDownloadLayer("white_set", { backdrop: "white", layer: "ground" }), "auto");
  for (const layer of ["set", "ground", "none"] as const) {
    assert.equal(studioDownloadLayer("white_set", { backdrop: "white_set", layer }), layer);
    assert.equal(studioDownloadLayer("silver", { backdrop: "white_set", layer }), "none");
  }
});

test("同单共享一次状态读取：恢复准备中的记录不会暂缓预览或自动下载", async t => {
  let reads = 0;
  const { store, links, postBodies } = fixture(t, {
    list: async () => ({ items: [record(++reads === 1 ? "preparing" : "ready")] }),
  });
  const leaveFront = store.watch(jobId, owner);
  const leaveBack = store.watch(jobId, owner);
  await tick(t);
  assert.equal(reads, 1);
  assert.equal(store.snapshot(jobId, owner).entries[0]?.kind, "preparing");
  assert.equal(store.snapshot(jobId, owner).preparing, false);

  await tick(t, 1_000);
  const result = store.snapshot(jobId, owner).entries[0];
  assert.ok(result?.kind === "ready");
  assert.equal(result.href, href);
  assert.equal(result.handedOff, false);
  assert.deepEqual(links, []);
  assert.deepEqual(postBodies, []);
  leaveFront();
  leaveBack();
  assert.deepEqual(store.snapshot(jobId, owner).entries, []);
});

test("本单达到保存上限时继续展示原因及已有成片", async t => {
  const { store, links } = fixture(t, {
    list: async () => ({ items: [record("ready")] }),
    prepare: async () => { throw new ApiError(429, "成片已满", false, null, "studio_download_capacity"); },
  });
  store.watch(jobId, owner);
  await tick(t);
  const next = { ...request, backdrop: "silver" as const, layer: "none" as const };
  await store.start(jobId, owner, next);
  await tick(t, 1_000);
  const entries = store.snapshot(jobId, owner).entries;
  assert.equal(studioDownloadFor(entries, next)?.kind, "capacity");
  assert.equal(studioDownloadFor(entries, request)?.kind, "ready");
  assert.deepEqual(links, []);
});

test("主动下载同一选择去重，跨页面仍只交给浏览器一次", async t => {
  const accepted = deferred<unknown>();
  const { store, links, postBodies } = fixture(t, {
    prepare: () => accepted.promise,
    list: async () => ({ items: [record("ready")] }),
  });
  const leave = store.watch(jobId, owner);
  const pending = store.start(jobId, owner, request);
  assert.equal(store.snapshot(jobId, owner).preparing, true);
  await store.start(jobId, owner, { ...request });
  assert.deepEqual(postBodies, [studioDownloadBody(request)]);

  leave();
  accepted.resolve(record("preparing"));
  await pending;
  assert.equal(store.snapshot(jobId, owner).entries[0]?.kind, "preparing");
  await tick(t, 1_000);
  assert.deepEqual(links, [href]);
  await tick(t, 10_000);
  assert.deepEqual(links, [href]);

  const reopen = store.watch(jobId, owner);
  await tick(t);
  const result = store.snapshot(jobId, owner).entries[0];
  assert.ok(result?.kind === "ready");
  assert.equal(result.handedOff, false);
  assert.deepEqual(links, [href]);
  reopen();
});

test("服务端失败可重试冻结的旧版；显式再下载由服务端确认文件仍然有效", async t => {
  let attempts = 0;
  const { store, links, postBodies } = fixture(t, {
    prepare: async () => record(++attempts === 1 ? "preparing" : "ready"),
    list: async () => ({ items: [record("failed")] }),
  });
  const leave = store.watch(jobId, owner);
  await store.start(jobId, owner, request);
  await tick(t, 1_000);
  const snapshot = store.snapshot(jobId, owner);
  assert.equal(snapshot.preparing, false);
  const failed = studioDownloadFor(snapshot.entries, request);
  assert.equal(failed?.kind, "failed");
  assert.equal(studioDownloadFor(snapshot.entries, { ...request, generation: "g2-other" }), undefined);
  assert.equal(studioDownloadFor(snapshot.entries, { ...request, backdrop: "white" }), undefined);
  assert.equal(studioDownloadFor(snapshot.entries, { ...request, productLight: 1 }), undefined);

  assert.ok(failed?.kind === "failed");
  await store.start(jobId, owner, failed.selection);
  await store.start(jobId, owner, failed.selection);
  assert.deepEqual(postBodies, Array.from({ length: 3 }, () => studioDownloadBody(request)));
  assert.deepEqual(links, [href, href]);
  leave();
});

test("POST 回应丢失时显示重试，随后可恢复附件而不自动下载", async t => {
  const { store, links } = fixture(t, {
    prepare: async () => { throw new TypeError("响应丢失"); },
    list: async () => ({ items: [record("ready")] }),
  });
  const leave = store.watch(jobId, owner);
  await store.start(jobId, owner, request);
  assert.equal(store.snapshot(jobId, owner).entries[0]?.kind, "failed");
  await tick(t, 1_000);
  const entries = store.snapshot(jobId, owner).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "ready");
  assert.deepEqual(links, []);
  leave();
});

test("登录身份切换为新集合，旧轮询状态和旧页面点击不越界", async t => {
  const oldResponse = deferred<unknown>();
  let oldSignal: AbortSignal | undefined;
  let calls = 0;
  const { store, links, postBodies } = fixture(t, {
    list: (_id, signal) => {
      if (++calls !== 1) return Promise.resolve({ items: [] });
      oldSignal = signal;
      return oldResponse.promise;
    },
  });
  const leaveOld = store.watch(jobId, owner);
  await store.start(jobId, owner, request);
  await tick(t, 1_000);
  assert.ok(oldSignal);
  store.setOwner("actor-b");
  assert.equal(oldSignal.aborted, true);
  const leaveNew = store.watch(jobId, "actor-b");
  await tick(t);
  oldResponse.resolve({ items: [record("ready")] });
  await tick(t);
  await store.start(jobId, owner, request);
  assert.deepEqual(store.snapshot(jobId, owner).entries, []);
  assert.deepEqual(store.snapshot(jobId, "actor-b").entries, []);
  assert.deepEqual(postBodies, [studioDownloadBody(request)]);
  assert.deepEqual(links, []);
  leaveOld();
  leaveNew();
});

test("页面结束后晚到的准备响应不启动自动下载", async t => {
  const accepted = deferred<unknown>();
  const { store, links } = fixture(t, { prepare: () => accepted.promise });
  const leave = store.watch(jobId, owner);
  const pending = store.start(jobId, owner, request);
  store.abandonHandoffs();
  accepted.resolve(record("ready"));
  await pending;
  const result = store.snapshot(jobId, owner).entries[0];
  assert.ok(result?.kind === "ready");
  assert.equal(result.handedOff, false);
  assert.deepEqual(links, []);
  leave();
});

test("状态读取反复失败会结束准备提示并保留原选择以供重试", async t => {
  let reads = 0;
  const { store, links } = fixture(t, {
    list: async () => {
      reads += 1;
      throw new TypeError("状态不可见");
    },
  });
  const leave = store.watch(jobId, owner);
  await store.start(jobId, owner, request);
  await tick(t, 1_000);
  assert.equal(store.snapshot(jobId, owner).preparing, false);
  await tick(t, 2_000);
  await tick(t, 4_000);
  assert.deepEqual(store.snapshot(jobId, owner).entries[0]?.selection, request);
  assert.equal(store.snapshot(jobId, owner).entries[0]?.kind, "unreachable");
  await tick(t, 10_000);
  assert.equal(reads, 3);

  await store.start(jobId, owner, request);
  assert.equal(store.snapshot(jobId, owner).preparing, true);
  await tick(t, 1_000);
  assert.equal(store.snapshot(jobId, owner).entries[0]?.kind, "preparing");
  await tick(t, 2_000);
  await tick(t, 4_000);
  assert.equal(reads, 6);
  assert.equal(store.snapshot(jobId, owner).entries[0]?.kind, "unreachable");
  assert.deepEqual(links, []);
  leave();
});
