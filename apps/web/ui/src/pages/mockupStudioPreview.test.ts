import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadStudioPreview, loadStillImage, observeStudioFrame,
  prepareStudioCanvas, releaseCanvasBacking, releaseStudioGeneration, setCanvasBacking, studioAssetHref,
  studioDrawnUpgradeFailed, studioPreviewSummary, studioStillCacheHas, studioStillCacheSize,
  type StudioPreviewSources,
} from "./mockupStudio.js";

const image = (src: string) => ({ src, naturalWidth: 3000, naturalHeight: 3600 }) as HTMLImageElement;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const urls = { product: { full: "p", card: "pc" }, ground: { full: "g", card: "gc" }, set: { full: "s", card: "sc" } };

test("asset URLs retain legacy behavior and encode a generation shared by cards, originals and downloads", () => {
  assert.equal(studioAssetHref("job", "white_a"), "/api/mockups/job/files/white_a");
  assert.equal(studioAssetHref("job", "white_a", "", true), "/api/mockups/job/files/white_a?download=1");
  for (const key of ["white_a", "white_a_card", "white_a_ground", "white_a_set"]) {
    const url = new URL(studioAssetHref("job", key, "2026-09-05T12:00:00+08:00", true), "https://synthetic.invalid");
    assert.equal(url.searchParams.get("generation"), "2026-09-05T12:00:00+08:00");
    assert.equal(url.searchParams.get("download"), "1");
  }
});

test("same-job relight cannot replace new cards with old cached full images", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  let current = "old";
  class FakeImage {
    src = "";
    generation = current;
    naturalWidth = 3000;
    naturalHeight = 3600;
    async decode() {}
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  try {
    for (const generation of ["old", "new"]) {
      current = generation;
      const source = (key: string) => ({ full: studioAssetHref("relight-regression", key, generation), card: studioAssetHref("relight-regression", `${key}_card`, generation) });
      const published: string[] = [];
      const preview = loadStudioPreview({ product: source("white_a"), ground: source("white_a_ground"), set: null },
        (s) => published.push((s.product as unknown as FakeImage).generation), assert.fail,
        loadStillImage, async () => new FakeImage() as unknown as HTMLImageElement);
      preview.show("white_set", true);
      await tick(); await tick(); preview.cancel();
      assert.ok(published.length >= 2, "card and full must both publish");
      assert.ok(published.every((value) => value === generation), JSON.stringify(published));
      const downloaded = await loadStillImage(source("white_a").full);
      assert.equal((downloaded as unknown as FakeImage).generation, generation);
    }
    const evicted = await loadStillImage(studioAssetHref("relight-regression", "white_a", "old"));
    assert.equal((evicted as unknown as FakeImage).generation, "new", "old decoded generation is no longer retained in cache");
  } finally {
    if (original) Object.defineProperty(globalThis, "Image", original);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});

test("preview decodes selected backdrop cards before starting full upgrades", async () => {
  const pending = new Map<string, (value: HTMLImageElement) => void>();
  const requested: string[] = [];
  const frames: StudioPreviewSources[] = [];
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    (url) => new Promise((resolve) => pending.set(url, resolve)),
    async (url) => { requested.push(url); return image(url); });
  preview.show("white_set", false);
  await tick();
  assert.deepEqual(requested, ["pc", "sc"]);
  assert.equal(pending.size, 0, "nothing full starts before the page permits it");
  assert.equal(frames[0]?.product.src, "pc");
  assert.equal(frames.at(-1)?.set?.src, "sc");
  assert.equal(frames.at(-1)?.ground, null, "the set replaces the ground shadow");

  preview.show("white_set", true);
  assert.deepEqual([...pending.keys()], ["p", "s"]);
  pending.get("p")!(image("p"));
  pending.get("s")!(image("s"));
  await tick();
  assert.equal(frames.at(-1)?.product.naturalWidth, 3000);
  assert.equal(frames.at(-1)?.set?.src, "s");
  assert.equal(frames[0].product.src, "pc", "published snapshots are immutable");
  preview.cancel();
});

test("white and silver stay product-only and switching to white set only requests the missing backdrop", async () => {
  const requested: string[] = [];
  const frames: StudioPreviewSources[] = [];
  const load = async (url: string) => { requested.push(url); return image(url); };
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail, load, load);
  preview.show("white", false);
  await tick();
  assert.deepEqual(requested, ["pc"]);
  preview.show("silver", false);
  await tick();
  assert.deepEqual(requested, ["pc"]);
  preview.show("white_set", false);
  await tick();
  assert.deepEqual(requested, ["pc", "sc"]);
  assert.equal(frames.at(-1)?.set?.src, "sc");
  preview.cancel();
});

test("a generation switch shares the active URL and keeps failed URLs retryable", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  class FakeImage {
    src = "";
    decode() { return new Promise<void>((resolve, reject) => pending.push({ resolve, reject })); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  try {
    const oldUrl = studioAssetHref("cache-rejection-race", "white_a", "old");
    const newUrl = studioAssetHref("cache-rejection-race", "white_a", "new");
    const oldRequest = loadStillImage(oldUrl);
    const oldFailure = assert.rejects(oldRequest, /late decode failure/);
    const newerGeneration = loadStillImage(newUrl);
    assert.equal(studioStillCacheHas(oldUrl), false);
    assert.equal(loadStillImage(oldUrl), oldRequest, "returning to the active URL shares its request");
    assert.equal(pending.length, 1, "another generation waits for the active image");
    pending[0].reject(new Error("late decode failure"));
    await oldFailure;
    const retriedOld = loadStillImage(oldUrl);
    assert.notEqual(retriedOld, oldRequest);
    assert.equal(loadStillImage(oldUrl), retriedOld, "retry shares the new promise");
    assert.equal(loadStillImage(newUrl), newerGeneration, "old failure keeps the new generation's request");
    await tick();
    assert.equal(pending.length, 2);
    pending[1].resolve();
    await newerGeneration;
    await tick();
    assert.equal(pending.length, 3);
    pending[2].resolve();
    await retriedOld;
  } finally {
    if (original) Object.defineProperty(globalThis, "Image", original);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});

test("failed full upgrades retain usable cards without reporting a broken preview", async () => {
  const frames: StudioPreviewSources[] = [];
  const preview = loadStudioPreview({ ...urls, set: null }, (frame) => frames.push(frame), assert.fail,
    async () => { throw new Error("full unavailable"); }, async (url) => image(url));
  preview.show("white_set", true);
  await tick();
  await tick();
  const last = frames.at(-1)!;
  assert.equal(last.product.src, "pc");
  assert.equal(last.facts.product.upgradeFailed, true);
  assert.equal(last.facts.ground.upgradeFailed, true);
  assert.equal(studioDrawnUpgradeFailed(last.facts, "white", last.set), true);
});

test("missing cards fall back to full; optional set failure does not hide product", async () => {
  const frames: StudioPreviewSources[] = [];
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    async (url) => { if (url === "s") throw new Error("missing set"); return image(url); },
    async () => { throw new Error("415"); });
  preview.show("white_set", true);
  await tick();
  assert.equal(frames.at(-1)?.product.src, "p");
  assert.equal(frames.at(-1)?.set, null);
});

test("missing mandatory ground reports failure and never publishes an incomplete composition", async () => {
  let failed = 0;
  const preview = loadStudioPreview({ ...urls, set: null }, () => assert.fail("must not publish"), () => failed++,
    async (url) => { if (url === "g") throw new Error("missing"); return image(url); }, async () => { throw new Error("415"); });
  preview.show("white_set", false);
  await tick();
  assert.equal(failed, 1);
});

test("cancellation suppresses late initial results and late errors", async () => {
  for (const reject of [false, true]) {
    let finish!: () => void;
    const waiting = new Promise<HTMLImageElement>((resolve, fail) => {
      finish = () => reject ? fail(new Error("late")) : resolve(image("late"));
    });
    const preview = loadStudioPreview({ product: { full: "p" }, ground: { full: "g" }, set: null },
      () => assert.fail("late publication"), () => assert.fail("late error"), () => waiting);
    preview.show("white_set", false);
    preview.cancel(); finish(); await tick();
  }
});

test("cancellation after card publication prevents old full images replacing a new job", async () => {
  const frames: StudioPreviewSources[] = [];
  let finish!: (image: HTMLImageElement) => void;
  const waiting = new Promise<HTMLImageElement>((resolve) => { finish = resolve; });
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    () => waiting, async (url) => image(url));
  preview.show("white_set", true);
  await tick(); preview.cancel(); finish(image("old-full")); await tick();
  assert.ok(frames.length >= 1);
  assert.ok(frames.every((frame) => frame.product.src === "pc"));
  assert.ok(frames.every((frame) => frame.product.src !== "old-full"));
});

test("frame observer coalesces resize, handles DPR and zero sizes, and removes listeners", () => {
  const original = Object.getOwnPropertyDescriptors(globalThis);
  let resize!: () => void;
  let changed!: () => void;
  let queued: (() => void) | undefined;
  let disconnected = false;
  let mediaListeners = 0;
  const windowFake = { devicePixelRatio: 1, addEventListener: (_: string, cb: () => void) => { resize = cb; },
    removeEventListener: () => {}, matchMedia: () => ({ addEventListener: (_: string, cb: () => void) => { changed = cb; mediaListeners++; }, removeEventListener: () => { mediaListeners--; } }) };
  Object.assign(globalThis, { window: windowFake,
    requestAnimationFrame: (cb: () => void) => { queued = cb; return 1; }, cancelAnimationFrame: () => { queued = undefined; },
    ResizeObserver: class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() { disconnected = true; } },
  });
  try {
    const frame = { clientWidth: 342, clientHeight: 411 };
    const sizes: number[][] = [];
    const stop = observeStudioFrame(frame as HTMLElement, (w, h) => sizes.push([w, h]));
    const flush = () => { const cb = queued; queued = undefined; cb?.(); };
    flush();
    frame.clientWidth = 502; frame.clientHeight = 603;
    resize(); resize(); flush();
    windowFake.devicePixelRatio = 2; changed(); flush();
    resize(); flush();
    frame.clientWidth = 0; resize(); flush();
    assert.deepEqual(sizes, [[342, 411], [502, 603], [1004, 1206]]);
    resize(); stop(); flush();
    assert.equal(disconnected, true);
    assert.equal(mediaListeners, 0);
    assert.equal(sizes.length, 3);
  } finally {
    for (const key of ["window", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"]) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("frame observation still measures window resizes without ResizeObserver and uses DPR one fallback", () => {
  const keys = ["window", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"];
  const original = Object.getOwnPropertyDescriptors(globalThis);
  let onResize!: () => void;
  let queued: (() => void) | undefined;
  let removed = false;
  Object.assign(globalThis, {
    ResizeObserver: undefined,
    window: { devicePixelRatio: 0,
      addEventListener: (_: string, callback: () => void) => { onResize = callback; },
      removeEventListener: (_: string, callback: () => void) => { removed = callback === onResize; },
      matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    },
    requestAnimationFrame: (callback: () => void) => { queued = callback; return 1; },
    cancelAnimationFrame: () => { queued = undefined; },
  });
  try {
    const frame = { clientWidth: 100, clientHeight: 120 };
    const sizes: number[][] = [];
    const stop = observeStudioFrame(frame as HTMLElement, (w, h) => sizes.push([w, h]));
    const flush = () => { const callback = queued; queued = undefined; callback?.(); };
    flush();
    frame.clientWidth = 200; onResize(); flush();
    assert.deepEqual(sizes, [[100, 120], [200, 120]]);
    stop(); onResize();
    assert.equal(removed, true);
    assert.equal(queued, undefined, "stopped observers must not schedule more work");
  } finally {
    for (const key of keys) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("pending optional set does not block first paint or product/ground full upgrades", async () => {
  const pending = new Map<string, (value: HTMLImageElement) => void>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve) => pending.set(url, resolve));
  const frames: StudioPreviewSources[] = [];
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail, wait, wait);
  preview.show("white_set", false);
  pending.get("pc")!(image("pc"));
  await tick();
  assert.deepEqual(frames.map((frame) => [frame.product.src, frame.ground, frame.set]), [["pc", null, null]]);
  assert.equal(pending.has("gc"), false);

  preview.show("white_set", true);
  pending.get("gc")!(image("gc"));
  pending.get("p")!(image("p"));
  await tick();
  pending.get("g")!(image("g"));
  await tick();
  assert.equal(frames.at(-1)?.product.src, "p");
  assert.equal(frames.at(-1)?.ground?.src, "g");
  assert.equal(frames.at(-1)?.set, null);
  pending.get("sc")!(image("sc"));
  await tick();
  assert.equal(frames.at(-1)?.set?.src, "sc");
  pending.get("s")!(image("s"));
  await tick();
  assert.equal(frames.at(-1)?.set?.src, "s");
  preview.cancel();
});

test("set arriving first still waits for product and does not need ground", async () => {
  const pending = new Map<string, (value: HTMLImageElement) => void>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve) => pending.set(url, resolve));
  const frames: StudioPreviewSources[] = [];
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail, wait, wait);
  preview.show("white_set", false);
  pending.get("sc")!(image("sc"));
  await tick();
  assert.equal(frames.length, 0);
  pending.get("pc")!(image("pc"));
  await tick();
  assert.equal(frames.at(-1)?.set?.src, "sc");
  assert.equal(pending.has("gc"), false);
  preview.cancel();
});

test("late set after cancel does not publish or start a new full", async () => {
  const pending = new Map<string, (value: HTMLImageElement) => void>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve) => pending.set(url, resolve));
  const fulls: string[] = [];
  const frames: StudioPreviewSources[] = [];
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    async (url) => { fulls.push(url); return wait(url); }, wait);
  preview.show("white_set", false);
  pending.get("pc")!(image("pc"));
  await tick();
  preview.show("white_set", true);
  preview.cancel();
  pending.get("sc")!(image("sc"));
  pending.get("gc")!(image("gc"));
  await tick();
  assert.ok(frames.every((frame) => frame.set == null));
  assert.deepEqual(fulls, ["p"]);
});

test("pausing automatic upgrades keeps the card and resumes when download work finishes", async () => {
  const frames: StudioPreviewSources[] = [];
  const fulls: Array<(value: HTMLImageElement) => void> = [];
  const preview = loadStudioPreview(urls, (frame) => frames.push(frame), assert.fail,
    () => new Promise<HTMLImageElement>(resolve => fulls.push(resolve)),
    async (url) => image(url));

  preview.show("white", true);
  await tick();
  assert.equal(fulls.length, 1);
  preview.show("white", false);
  fulls[0](image("old-full"));
  await tick();
  assert.equal(frames.at(-1)?.product.src, "pc");

  preview.show("white", true);
  assert.equal(fulls.length, 2);
  fulls[1](image("p"));
  await tick();
  assert.equal(frames.at(-1)?.product.src, "p");
  preview.cancel();
});

test("cancel then late card failure does not start full or refill stillLoads", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const cards: Array<{ reject: (error: Error) => void }> = [];
  class FakeImage {
    src = "";
    crossOrigin = "";
    async decode() { return new Promise<void>((_resolve, reject) => cards.push({ reject })); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  try {
    const job = "cancel-refill";
    const generation = "gen-old";
    const source = (key: string) => ({
      full: studioAssetHref(job, key, generation),
      card: studioAssetHref(job, `${key}_card`, generation),
    });
    let fulls = 0;
    const loadFull = async (url: string) => {
      fulls++;
      return loadStillImage(url);
    };
    const preview = loadStudioPreview(
      { product: source("white_a"), ground: source("white_a_ground"), set: source("white_a_set") },
      () => assert.fail("must not publish after cancel"),
      () => assert.fail("must not fail after cancel"),
      loadFull,
    );
    preview.show("white_set", false);
    preview.cancel();
    releaseStudioGeneration(job, generation);
    for (const card of cards) card.reject(new Error("late card"));
    await tick();
    await tick();
    assert.equal(fulls, 0);
    assert.equal(studioStillCacheHas(source("white_a").full), false);
    assert.equal(studioStillCacheHas(source("white_a_ground").full), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "Image", original);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});

test("mandatory failure closes the preview so a late sibling does not start full", async () => {
  const pending = new Map<string, { resolve: (value: HTMLImageElement) => void; reject: (error: Error) => void }>();
  const wait = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => pending.set(url, { resolve, reject }));
  let fulls = 0;
  let failed = 0;
  const preview = loadStudioPreview({ ...urls, set: null }, () => assert.fail("incomplete composition"), () => failed++,
    async (url) => { fulls++; return wait(url); }, wait);
  preview.show("white_set", false);
  pending.get("pc")!.reject(new Error("415"));
  await tick();
  pending.get("p")!.reject(new Error("missing product"));
  await tick();
  assert.equal(failed, 1);
  const fullsAfterProduct = fulls;
  pending.get("gc")!.reject(new Error("415"));
  await tick();
  assert.equal(fulls, fullsAfterProduct, "ground must not start full after the preview already failed");
  assert.equal(failed, 1, "late sibling result does not report the same failure twice");
});

test("failed full is requested again on a new preview of the same identity", async () => {
  const fulls: string[] = [];
  const loadFull = async (url: string) => {
    fulls.push(url);
    throw new Error(`full ${url}`);
  };
  const loadCard = async (url: string) => image(url);
  for (let attempt = 0; attempt < 2; attempt++) {
    const preview = loadStudioPreview(urls, () => undefined, assert.fail, loadFull, loadCard);
    preview.show("white_set", false);
    await tick();
    preview.show("white_set", true);
    await tick();
    preview.cancel();
  }
  assert.deepEqual(fulls, ["p", "s", "p", "s"]);
});

test("setCanvasBacking skips identical sizes; releaseCanvasBacking zeros the backing store", () => {
  const writes: string[] = [];
  const box = { w: 10, h: 20 };
  const canvas = {} as HTMLCanvasElement;
  Object.defineProperty(canvas, "width", {
    get: () => box.w,
    set: (value: number) => { writes.push(`w:${value}`); box.w = value; },
  });
  Object.defineProperty(canvas, "height", {
    get: () => box.h,
    set: (value: number) => { writes.push(`h:${value}`); box.h = value; },
  });
  assert.equal(setCanvasBacking(canvas, 10, 20), false);
  assert.deepEqual(writes, []);
  assert.equal(setCanvasBacking(canvas, 10.4, 19.6), false);
  assert.deepEqual(writes, []);
  assert.equal(setCanvasBacking(canvas, 30, 20), true);
  assert.deepEqual(writes, ["w:30", "h:20"]);
  assert.equal(setCanvasBacking(canvas, 30, 40), true);
  assert.deepEqual(writes, ["w:30", "h:20", "w:30", "h:40"]);
  releaseCanvasBacking(canvas);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});

test("prepareStudioCanvas clears same-size redraws and releases when context is missing", () => {
  const writes: string[] = [];
  const box = { w: 10, h: 20 };
  const ops: string[] = [];
  const canvas = {
    getContext(kind: string) {
      assert.equal(kind, "2d");
      return {
        setTransform(...args: number[]) { ops.push(`setTransform:${args.join(",")}`); },
        clearRect(...args: number[]) { ops.push(`clearRect:${args.join(",")}`); },
        get globalAlpha() { return 0.5; },
        set globalAlpha(value: number) { ops.push(`alpha:${value}`); },
        get globalCompositeOperation() { return "multiply"; },
        set globalCompositeOperation(value: string) { ops.push(`op:${value}`); },
        get filter() { return "brightness(1.2)"; },
        set filter(value: string) { ops.push(`filter:${value}`); },
      };
    },
  } as unknown as HTMLCanvasElement;
  Object.defineProperty(canvas, "width", {
    get: () => box.w,
    set: (value: number) => { writes.push(`w:${value}`); box.w = value; },
  });
  Object.defineProperty(canvas, "height", {
    get: () => box.h,
    set: (value: number) => { writes.push(`h:${value}`); box.h = value; },
  });
  assert.ok(prepareStudioCanvas(canvas, 10, 20));
  assert.deepEqual(writes, []);
  assert.ok(ops.some((op) => op.startsWith("clearRect:0,0,10,20")));
  assert.ok(ops.includes("filter:none"));
  const empty = { width: 8, height: 8, getContext() { return null; } } as unknown as HTMLCanvasElement;
  assert.equal(prepareStudioCanvas(empty, 8, 8), null);
  assert.equal(empty.width, 0);
  assert.equal(empty.height, 0);
});

test("same-asset generation load evicts the previous stillLoads entry; release drops the rest", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
  class FakeImage {
    src = "";
    crossOrigin = "";
    async decode() {}
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  try {
    const g1 = "g1-q05-cache-" + "a".repeat(8);
    const g2 = "g2-q05-cache-" + "b".repeat(8);
    const job = "q05-cache-job";
    const before = studioStillCacheSize();
    await loadStillImage(studioAssetHref(job, "white_a", g1));
    await loadStillImage(studioAssetHref(job, "white_a_ground", g1));
    assert.equal(studioStillCacheSize(), before + 2);
    await loadStillImage(studioAssetHref(job, "white_a", g2));
    assert.equal(studioStillCacheHas(studioAssetHref(job, "white_a", g1)), false, "same path must not retain every generation");
    assert.equal(studioStillCacheHas(studioAssetHref(job, "white_a_ground", g1)), true);
    assert.equal(studioStillCacheHas(studioAssetHref(job, "white_a", g2)), true);
    await loadStillImage(studioAssetHref(job, "white_a_ground", g2));
    assert.equal(studioStillCacheHas(studioAssetHref(job, "white_a_ground", g1)), false);
    releaseStudioGeneration(job, g2);
    assert.equal(studioStillCacheHas(studioAssetHref(job, "white_a", g2)), false);
    assert.equal(studioStillCacheHas(studioAssetHref(job, "white_a_ground", g2)), false);
    assert.equal(studioStillCacheSize(), before);
  } finally {
    if (original) Object.defineProperty(globalThis, "Image", original);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});

test("drawn-layer summary ignores unused set and records white_set fallback", () => {
  const cards = {
    product: { origin: "full" as const, fetch: "ready" as const },
    ground: { origin: "card" as const, fetch: "ready" as const },
    set: { origin: "card" as const, fetch: "ready" as const },
  };
  assert.deepEqual(studioPreviewSummary(cards, "white", image("s")), { source: "full", setFallback: false });
  assert.deepEqual(studioPreviewSummary(cards, "white_set", image("s")), { source: "mixed", setFallback: false });
  const noSet = { ...cards, set: { origin: "none" as const, fetch: "failed" as const } };
  assert.deepEqual(studioPreviewSummary(noSet, "white_set", null), { source: "mixed", setFallback: true });
  const allFull = {
    product: { origin: "full" as const, fetch: "ready" as const },
    ground: { origin: "full" as const, fetch: "ready" as const },
    set: { origin: "none" as const, fetch: "pending" as const },
  };
  assert.deepEqual(studioPreviewSummary(allFull, "white_set", null), { source: "full", setFallback: true });
  assert.equal(studioDrawnUpgradeFailed({
    product: { origin: "card", fetch: "ready", upgradeFailed: true },
    ground: { origin: "full", fetch: "ready" },
    set: { origin: "none", fetch: "failed", upgradeFailed: true },
  }, "white", null), true);
  assert.equal(studioDrawnUpgradeFailed({
    product: { origin: "full", fetch: "ready" },
    ground: { origin: "full", fetch: "ready" },
    set: { origin: "none", fetch: "failed", upgradeFailed: true },
  }, "white", null), false);
});
