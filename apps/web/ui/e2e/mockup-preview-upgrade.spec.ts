import { carton } from "./fixtures/glbFixture";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cpus, hostname, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { studioDownloadTest as test, type StudioFiles } from "./fixtures/nativeStudioFiles";
import { pngFill } from "./fixtures/pngFixture";
import { studioDownloadsFixture, type StudioPreparation, type StudioSelection } from "./fixtures/studioDownloadsFixture";
import {
  Q05_IDENTITY_FILE,
  Q05_PREBUILT_ENV,
  cleanupQ05Artifact,
  fileSha,
  q05MeasurementWindows,
  resolveQ05Artifact,
  type Q05ArtifactSource,
} from "./q05Artifact";
import type { MockupJob, RenderGenerationRow } from "../src/api";

// 产物来源：
// - 默认：beforeAll 自建 mkdtemp 临时目录并 `npm run build -- --outDir <dir>`，afterAll 只删该目录。
// - 显式复用：BEIAN_Q05_DIST=<dir> 只读使用外部已构建产物，校验路径/必要资产/sidecar 身份，
//   任一项不通过即失败关闭，不自动回退构建；该外部目录永不被删除。
// PLAYWRIGHT_ARTIFACT_ONLY=1 与本 spec 的产物来源无关：本 spec 拦截全部页面与 API 请求，
// 该变量只影响 playwright.config 是否另起 5173 上的 Vite dev server。成片附件由独立回环端口提供。
let artifact: Q05ArtifactSource | undefined;
let indexHtml: Buffer;
const assets = new Map<string, Buffer>();
test.beforeAll(() => {
  artifact = resolveQ05Artifact({
    uiRoot: fileURLToPath(new URL("../", import.meta.url)),
    build: (dir) => {
      execFileSync("npm", ["run", "build", "--", "--outDir", dir], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 60_000, stdio: "pipe",
      });
    },
  });
  indexHtml = artifact.indexHtml;
  for (const [key, body] of artifact.assets) assets.set(key, body);
});
test.afterAll(() => { cleanupQ05Artifact(artifact); });

const ID = "af0900000001";
const GEN = "g1-rf09-preview-" + "a".repeat(48);
const GEN2 = "g2-rf09-preview-" + "b".repeat(48);
const FULL_UPGRADE_NOTICE = "高清图暂时未加载，重新打开此单可重试";
const STUDIO_DOWNLOAD_FAILED = "成片下载失败，请重试";
const MEASURE_DIR = process.env.RF09_MEASURE_DIR || "";
const UI_ROOT = fileURLToPath(new URL("../", import.meta.url));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const FLOW = {
  productCard: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect x="20" y="24" width="40" height="48" fill="#c80000"/></svg>',
  productFull: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect x="20" y="24" width="40" height="48" fill="#0014e6"/></svg>',
  groundCard: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#00a000"/></svg>',
  groundFull: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#c8c800"/></svg>',
  setCard: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#c800c8"/></svg>',
  setFull: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#00c8c8"/></svg>',
};

function jobModel(): MockupJob {
  const files = [
    "white_a", "white_b", "white_a_ground", "white_b_ground", "white_a_set", "white_b_set",
    "white_a_card", "white_b_card", "white_a_ground_card", "white_b_ground_card", "white_a_set_card", "white_b_set_card", "glb",
  ].map((key) => ({ key, name: key === "glb" ? "box.glb" : `${key}.png` }));
  return {
    id: ID, title: "SYNTHETIC RF-09", owner: "ou_synthetic", status: "done", files,
    current_render_generation_id: GEN,
    render_generation_capabilities: {
      history: { allowed: true },
      activate: { allowed: false, reason: "generation_missing" },
      legacy_relight: { allowed: true },
      upgrade: { allowed: false, reason: "upgrade_unwired" },
    },
  };
}

type Gate = (ReturnType<typeof deferred> & { abort?: boolean }) | "fail" | "open";
type GateMap = Record<string, Gate>;

function studioPng({ backdrop, layer }: StudioSelection, width: number, height: number) {
  const background: [number, number, number, number] = backdrop === "white" ? [238, 238, 238, 255]
    : backdrop === "silver" ? [196, 201, 208, 255]
    : layer === "ground" ? [179, 179, 0, 255]
    : layer === "none" ? [238, 238, 236, 255] : [0, 200, 200, 255];
  return pngFill(width, height, background, {
    x: width / 4, y: height / 4, w: width / 2, h: height / 2, color: [0, 15, 234, 255],
  });
}

function studioRequest(file_key: StudioSelection["file_key"], backdrop: StudioSelection["backdrop"], layer: StudioSelection["layer"], generation = GEN) {
  return {
    file_key, backdrop, layer, generation_id: generation, product_light: 1, background_light: 1,
  };
}

function layerBody(key: string, pngs?: Map<string, Buffer>): { type: string; body: string | Buffer } | null {
  if (key === "glb") return { type: "model/gltf-binary", body: carton() };
  const card = key.endsWith("_card");
  const base = card ? key.slice(0, -5) : key;
  const kind = base.includes("set") ? "set" : base.includes("ground") ? "ground" : "product";
  if (pngs) {
    const body = pngs.get(`${kind}:${card ? "card" : "full"}`);
    if (body) return { type: "image/png", body };
  }
  const svg = kind === "product" ? (card ? FLOW.productCard : FLOW.productFull)
    : kind === "ground" ? (card ? FLOW.groundCard : FLOW.groundFull)
    : (card ? FLOW.setCard : FLOW.setFull);
  return { type: "image/svg+xml", body: svg };
}

async function serve(surface: Page | BrowserContext, studioFiles: StudioFiles, opts: {
  gates?: GateMap;
  pngs?: Map<string, Buffer>;
  job?: MockupJob;
  urls?: string[];
  history?: RenderGenerationRow[];
  studioPrepare?: (selection: StudioSelection) => StudioPreparation;
  studioSize?: [number, number];
}) {
  const job = opts.job || jobModel();
  const urls = opts.urls || [];
  const studio = studioDownloadsFixture({
    jobId: job.id,
    files: studioFiles,
    prepare: opts.studioPrepare,
    png: (selection) => studioPng(selection, ...(opts.studioSize ?? [80, 96])),
  });
  await surface.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!path.startsWith("/api/")) {
      const body = assets.get(path) || (path.startsWith("/mockup") ? indexHtml : null);
      return body
        ? route.fulfill({ body, contentType: path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html" })
        : route.fulfill({ status: 404, body: "synthetic asset not supplied" });
    }
    if (path === "/api/auth/me") return json({ logged_in: true, display_name: "SYNTHETIC", open_id: "ou_synthetic", role: "reviewer", perms: ["read", "create", "confirm_structure"] });
    if (path === "/api/status" || path === "/api/health") return json({ ok: true, version: "0.0.0.0", jobs: {} });
    if (path === "/api/uploads" || path === "/api/tasks") return json([]);
    if (path === "/api/mockups") return json([job]);
    if (path === `/api/mockups/${job.id}`) return json(job);
    if (path === `/api/mockups/${job.id}/render-generations` && method === "GET") {
      return json({ items: opts.history || [], next_cursor: null });
    }
    if (path.startsWith(`/api/mockups/${job.id}/render-generations/`) && path.endsWith("/activate")) {
      const generationId = decodeURIComponent(path.slice(
        `/api/mockups/${job.id}/render-generations/`.length,
        -"/activate".length,
      ));
      job.current_render_generation_id = generationId;
      if (opts.history) {
        for (const row of opts.history) row.current = row.generation_id === generationId;
      }
      return json(job);
    }
    if (path === `/api/mockups/${job.id}/render-generations` && method === "POST") {
      urls.push(`POST:${path}`);
      return json({ message: "not used" }, 409);
    }
    if (studio.matches(path)) return studio.handle(route);
    if (path.startsWith(`/api/mockups/${job.id}/files/`)) {
      urls.push(url.href);
      const key = path.split("/").pop()!;
      const gate = opts.gates?.[key];
      if (gate === "fail") return route.fulfill({ status: 404, body: "missing" });
      if (gate && gate !== "open") {
        await gate.promise;
        if (gate.abort) return route.abort();
      }
      const payload = layerBody(key, opts.pngs);
      if (!payload) return route.fulfill({ status: 404, body: "no layer" });
      return route.fulfill({ contentType: payload.type, body: payload.body });
    }
    return json({ message: "synthetic route missing" }, 404);
  });
  return { job, urls, studio };
}

function canvas(page: Page, label = "正面与侧面成片") {
  return page.locator(`canvas[aria-label="${label}"]`);
}

function downloadCard(page: Page, caption: string) {
  return page.locator(".mockup-sheet-photo")
    .filter({ has: page.getByRole("button", { name: `下载${caption}`, exact: true }) });
}

function downloadStatus(page: Page, caption = "正面 + 侧面") {
  return downloadCard(page, caption).locator(".mockup-still-download-status").getByRole("status");
}

async function sample(page: Page, xr: number, yr: number, label = "正面与侧面成片") {
  return canvas(page, label).evaluate((node: HTMLCanvasElement, point: number[]) => {
    const x = Math.max(0, Math.min(node.width - 1, Math.floor(node.width * point[0])));
    const y = Math.max(0, Math.min(node.height - 1, Math.floor(node.height * point[1])));
    return Array.from(node.getContext("2d")!.getImageData(x, y, 1, 1).data);
  }, [xr, yr]);
}

function isRed(px: number[]) { return px[0] > 140 && px[0] > px[2] && px[3] > 200; }
function isBlue(px: number[]) { return px[2] > 140 && px[2] > px[0] && px[3] > 200; }
function isMagenta(px: number[]) { return px[0] > 120 && px[2] > 120 && px[1] < 80; }
function isCyan(px: number[]) { return px[1] > 120 && px[2] > 120 && px[0] < 80; }
function isGroundFallback(px: number[]) { return px[0] > 140 && px[1] > 140 && px[2] < 80; }

async function inspectDownload(page: Page, bytes: Buffer, x: number, y: number) {
  return page.evaluate(async ({ data, x, y }) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)]));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const px = Array.from(ctx.getImageData(x, y, 1, 1).data);
    const size = [image.width, image.height];
    image.close();
    return { px, size };
  }, { data: Array.from(bytes), x, y });
}

async function trackUnhandled(page: Page) {
  const errors: string[] = [];
  await page.addInitScript(() => {
    (window as Window & { __rf09Unhandled?: string[] }).__rf09Unhandled = [];
    window.addEventListener("unhandledrejection", (event) => {
      const bag = (window as Window & { __rf09Unhandled?: string[] }).__rf09Unhandled || [];
      bag.push(String(event.reason));
    });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    async snapshot() {
      const extra = await page.evaluate(() => (window as Window & { __rf09Unhandled?: string[] }).__rf09Unhandled || []);
      return [...errors, ...extra];
    },
  };
}

function q05Machine() {
  const cpu = cpus()[0];
  return {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpu?.model,
    cores: cpus().length,
    totalmem: totalmem(),
    loadavg: loadavg(),
  };
}

type Q05StudioProbe = { cacheSize: () => number; cacheUrls: () => string[] };

async function q05AttachHeap(page: Page) {
  const client = await page.context().newCDPSession(page);
  const send = (method: string) => (client as { send: (name: string) => Promise<unknown> }).send(method);
  await send("Runtime.enable");
  try { await send("Performance.enable"); } catch { /* optional */ }
  try { await send("HeapProfiler.enable"); } catch { /* optional */ }
  return {
    async sample(gc: boolean) {
      if (gc) {
        try { await send("HeapProfiler.collectGarbage"); } catch { /* Chromium may omit */ }
      }
      let usedSize: number | null = null;
      let totalSize: number | null = null;
      try {
        const usage = await send("Runtime.getHeapUsage") as { usedSize?: number; totalSize?: number };
        usedSize = usage.usedSize ?? null;
        totalSize = usage.totalSize ?? null;
      } catch { /* */ }
      let metrics: Array<{ name: string; value: number }> = [];
      try {
        const result = await send("Performance.getMetrics") as { metrics: Array<{ name: string; value: number }> };
        metrics = result.metrics;
      } catch { /* */ }
      const pick = (name: string) => metrics.find((row) => row.name === name)?.value ?? null;
      const memory = await page.evaluate(() => {
        const info = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
        return info
          ? { used: info.usedJSHeapSize, total: info.totalJSHeapSize, limit: info.jsHeapSizeLimit, method: "performance.memory" }
          : { used: null, total: null, limit: null, method: "unavailable_not_performance.memory" };
      });
      const cache = await page.evaluate(() => {
        const probe = (window as Window & { __q05Studio?: Q05StudioProbe }).__q05Studio;
        return probe ? { size: probe.cacheSize(), urls: probe.cacheUrls(), probe: true } : { size: null, urls: [] as string[], probe: false };
      });
      const canvases = await page.evaluate(() => Array.from(document.querySelectorAll("canvas")).map((node) => {
        const canvas = node as HTMLCanvasElement;
        return {
          label: canvas.getAttribute("aria-label"),
          width: canvas.width,
          height: canvas.height,
          cssW: canvas.clientWidth,
          cssH: canvas.clientHeight,
        };
      }));
      return {
        gc,
        memory,
        cdp: {
          usedSize,
          totalSize,
          jsHeapUsed: pick("JSHeapUsedSize"),
          jsHeapTotal: pick("JSHeapTotalSize"),
          nodes: pick("Nodes"),
          listeners: pick("JSEventListeners"),
        },
        cache,
        canvases,
        canvasPixels: canvases.reduce((sum, row) => sum + row.width * row.height, 0),
      };
    },
  };
}

test("首屏先发所选背景的卡图，正反面可看后才请求高清与模型", async ({ page, studioFiles }) => {
  const cards = deferred();
  const front = deferred();
  const full = deferred();
  const model = deferred();
  const { urls } = await serve(page, studioFiles, {
    gates: {
      white_a_card: front, white_b_card: cards, white_a_set_card: cards, white_b_set_card: cards,
      white_a: full, white_b: full, white_a_set: full, white_b_set: full, glb: model,
    },
  });
  const requested = () => urls.map((url) => new URL(url).pathname.split("/").at(-1)).sort();
  const firstWave = ["white_a_card", "white_a_set_card", "white_b_card", "white_b_set_card"];
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => firstWave.every((key) => requested().includes(key))).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(requested()).toEqual(firstWave);
    for (const href of urls) {
      const url = new URL(href);
      expect(url.searchParams.get("generation_id")).toBe(GEN);
      expect(url.searchParams.get("compact")).toBe("1");
    }

    cards.release();
    await expect(canvas(page, "反面与侧面成片")).toHaveAttribute("data-preview-source", "card");
    expect(requested()).toEqual(firstWave);

    front.release();
    await expect(canvas(page)).toHaveAttribute("data-preview-source", "card");
    await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
    await expect.poll(() => requested()).toEqual(expect.arrayContaining(["white_a", "glb"]));
    expect(requested().filter((key) => !key?.endsWith("_card") && key !== "glb")).toEqual(["white_a"]);
    expect(requested().filter((key) => key?.includes("ground"))).toEqual([]);

    full.release();
    await expect(canvas(page)).toHaveAttribute("data-preview-source", "full");
  } finally {
    front.release(); cards.release(); full.release(); model.release();
  }
});

test("冷缓存立即请求成片，准备失败后重试不等高清预览或 GLB", async ({ page, studioFiles }) => {
  const cards = deferred();
  const pending = deferred();
  const failed = { ...deferred(), failed: true } satisfies StudioPreparation;
  let response: StudioPreparation = failed;
  const { urls, studio } = await serve(page, studioFiles, {
    gates: {
      white_a_card: cards, white_b_card: cards, white_a_set_card: cards, white_b_set_card: cards,
      white_a: pending, white_a_set: pending, white_b: pending, white_b_set: pending, glb: pending,
    },
    studioPrepare: () => response,
    studioSize: [3000, 3600],
  });
  const requests = () => urls.map((href) => new URL(href).pathname.split("/").at(-1));
  const button = page.getByRole("button", { name: "下载反面 + 侧面", exact: true });
  const retry = page.getByRole("button", { name: "重试", exact: true });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await expect.poll(requests).toContain("white_b_card");
    await expect(button).toBeEnabled({ timeout: 2000 });
    await button.click();
    const frozen = studioRequest("white_b", "white_set", "auto");
    await expect.poll(() => studio.requests).toEqual([frozen]);
    const status = downloadStatus(page, "反面 + 侧面");
    await expect(status).toHaveText("正在准备成片");
    expect(studio.fileRequests).toEqual([]);
    expect(requests().every((key) => key?.endsWith("_card"))).toBe(true);
    failed.release();
    await expect(downloadStatus(page, "反面 + 侧面")).toContainText(STUDIO_DOWNLOAD_FAILED);

    cards.release();
    await expect(canvas(page, "反面与侧面成片")).toHaveAttribute("data-preview-source", "card");
    await expect.poll(requests).toContain("white_a");
    await expect.poll(requests).toContain("glb");
    response = "ready";
    const download = page.waitForEvent("download");
    await retry.click();
    const saved = await download;
    await expect(status).toHaveText("成片已交给浏览器下载");
    expect(studio.fileRequests).toEqual([new URL(saved.url()).pathname]);
    expect(saved.suggestedFilename()).toBe("white_b.png");
    const bytes = readFileSync((await saved.path())!);
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const center = await inspectDownload(page, bytes, 1500, 1800);
    expect(center.size).toEqual([3000, 3600]);
    expect(isBlue(center.px)).toBe(true);
    expect(isCyan((await inspectDownload(page, bytes, 100, 100)).px)).toBe(true);
    expect(studio.requests).toEqual([frozen, frozen]);
    expect(requests().filter((key) => !key?.endsWith("_card")).sort()).toEqual(["glb", "white_a"]);
  } finally {
    cards.release(); pending.release(); failed.release();
  }
});

test("只一面有地面图且缺卡时，另一面能分背景直接下载，3D 等待时用骨架", async ({ page, studioFiles }) => {
  const front = deferred();
  const model = deferred();
  const job = jobModel();
  job.files = job.files.filter(({ key }) => !key.endsWith("_card") && key !== "white_b_ground");
  const { urls, studio } = await serve(page, studioFiles, { job, gates: { white_a: front, glb: model } });
  const requested = () => urls.map((href) => new URL(href).pathname.split("/").at(-1));
  const button = page.getByRole("button", { name: "下载反面 + 侧面", exact: true });
  const backdrop = page.locator(".mockup-backdrop-switch");
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await expect.poll(requested).toContain("white_a");
    await expect(page.getByRole("button", { name: "打开反面 + 侧面原图", exact: true })).toBeVisible();
    const corners: number[][] = [];
    for (const label of ["白底", "银底"]) {
      await backdrop.getByText(label, { exact: true }).click();
      const download = page.waitForEvent("download");
      await button.click();
      const saved = await download;
      expect(saved.suggestedFilename()).toBe("white_b.png");
      const bytes = readFileSync((await saved.path())!);
      const center = await inspectDownload(page, bytes, 40, 48);
      expect(center.size).toEqual([80, 96]);
      expect(isBlue(center.px)).toBe(true);
      corners.push((await inspectDownload(page, bytes, 4, 4)).px);
    }
    expect(corners).toEqual([[238, 238, 238, 255], [196, 201, 208, 255]]);
    expect(studio.requests).toEqual([
      studioRequest("white_b", "white", "none"), studioRequest("white_b", "silver", "none"),
    ]);
    expect(requested()).toEqual(["white_a"]);

    front.release();
    await backdrop.getByText("白桌白墙", { exact: true }).click();
    await expect(canvas(page, "反面与侧面白底")).toBeVisible();
    await expect.poll(requested).toContain("glb");
    await expect(page.locator(".mockup-sheet-glb .mockup-glb-skeleton")).toBeVisible();
    await expect(page.locator(".mockup-sheet-glb img.mockup-glb-poster")).toHaveCount(0);
    await expect(canvas(page)).toHaveAttribute("data-preview-set", "full");
    expect(requested().filter((key) => key === "white_a_set")).toHaveLength(1);
    expect(requested().filter((key) => key === "white_b")).toHaveLength(1);
  } finally {
    front.release(); model.release();
  }
});

test("只有一面有地面图时，另一面成片失败仍可重试且预览继续", async ({ page, studioFiles }) => {
  const back = deferred();
  const failed = { ...deferred(), failed: true } satisfies StudioPreparation;
  const job = jobModel();
  job.files = job.files.filter(({ key }) => !key.endsWith("_card") && key !== "white_b_ground");
  let response: StudioPreparation = failed;
  const { urls, studio } = await serve(page, studioFiles, { job, gates: { white_b: back }, studioPrepare: () => response });
  const backRequests = () => urls.filter((href) => new URL(href).pathname.endsWith("/files/white_b"));
  const button = page.getByRole("button", { name: "下载反面 + 侧面", exact: true });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => backRequests().length).toBe(1);
    await button.click();
    const status = downloadStatus(page, "反面 + 侧面");
    await expect(status).toContainText("正在准备成片");
    failed.release();
    await expect(status).toContainText(STUDIO_DOWNLOAD_FAILED);
    await expect(button).toBeEnabled();

    response = "ready";
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("white_b.png");
    const center = await inspectDownload(page, readFileSync((await saved.path())!), 40, 48);
    expect(isBlue(center.px)).toBe(true);
    const frozen = studioRequest("white_b", "white_set", "none");
    expect(studio.requests).toEqual([frozen, frozen]);
    expect(backRequests()).toHaveLength(1);
    back.release();
    await expect(canvas(page, "反面与侧面白底")).toBeVisible();
  } finally {
    back.release(); failed.release();
  }
});

test("切换版本后旧代下载继续，未开始的旧代自动高清让位给新代", async ({ page, studioFiles }) => {
  const front = deferred();
  const oldStudio = deferred();
  const job = jobModel();
  job.has_render_generations = true;
  if (job.render_generation_capabilities) job.render_generation_capabilities.activate = { allowed: true };
  const history: RenderGenerationRow[] = [GEN, GEN2].map((generation_id) => ({
    generation_id, current: generation_id === GEN, mode: "legacy_relight",
    profile: "synthetic", quality_status: "unwired", created_at: "2026-09-08T00:00:00Z",
  }));
  const { urls, studio } = await serve(page, studioFiles, { job, history, gates: { white_a: front }, studioPrepare: () => oldStudio });
  const oldFullRequests = () => urls.map((href) => new URL(href))
    .filter((url) => url.searchParams.get("generation_id") === GEN)
    .map((url) => url.pathname.split("/").at(-1) ?? "")
    .filter((key) => /^white_[ab](?:_set|_ground)?$/.test(key));
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    const back = canvas(page, "反面与侧面成片");
    await expect(back).toHaveAttribute("data-preview-source", "card");
    await expect.poll(oldFullRequests).toEqual(["white_a"]);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载反面 + 侧面", exact: true }).click();
    const frozen = studioRequest("white_b", "white_set", "set");
    await expect.poll(() => studio.requests).toEqual([frozen]);
    await page.getByRole("button", { name: "出图版本", exact: true }).click();
    await page.locator(`[data-generation-id="${GEN2}"]`).getByRole("button", { name: "使用此版本" }).click();
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation", GEN2);
    await expect(back).toHaveAttribute("data-preview-source", "card");

    oldStudio.release();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("white_b.png");
    const corner = await inspectDownload(page, readFileSync((await saved.path())!), 4, 4);
    expect(isCyan(corner.px)).toBe(true);
    front.release();
    await expect(canvas(page)).toHaveAttribute("data-preview-source", "full");
    await expect(back).toHaveAttribute("data-preview-source", "full");
    expect(oldFullRequests()).toEqual(["white_a"]);
    expect(studio.requests).toEqual([frozen]);
  } finally {
    front.release(); oldStudio.release();
  }
});

test("切回已看过的版本，仍等新绘制的正反面才请求高清与模型", async ({ page, studioFiles }) => {
  const secondVersion = deferred();
  const model = deferred();
  const gates: GateMap = { glb: model };
  const job = jobModel();
  job.has_render_generations = true;
  if (job.render_generation_capabilities) job.render_generation_capabilities.activate = { allowed: true };
  const history: RenderGenerationRow[] = [GEN, GEN2].map((generation_id) => ({
    generation_id, current: generation_id === GEN, mode: "legacy_relight",
    profile: "synthetic", quality_status: "unwired", created_at: "2026-09-08T00:00:00Z",
  }));
  const { urls } = await serve(page, studioFiles, { gates, job, history });
  const requests = (generation: string, start = 0) => urls.slice(start).map((href) => new URL(href))
    .filter((url) => url.searchParams.get("generation_id") === generation)
    .map((url) => url.pathname.split("/").at(-1)).sort();
  const selectVersion = async (generation: string) => {
    await page.locator(`[data-generation-id="${generation}"]`).getByRole("button", { name: "使用此版本" }).click();
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation", generation);
  };
  const cards = ["white_a_card", "white_a_set_card", "white_b_card", "white_b_set_card"];
  const upgrades = ["white_a", "white_a_set", "white_b", "white_b_set", "glb"];
  const back = canvas(page, "反面与侧面成片");

  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => requests(GEN)).toEqual(expect.arrayContaining(upgrades));
    await page.getByRole("button", { name: "出图版本", exact: true }).click();

    for (const key of cards) gates[key] = secondVersion;
    await selectVersion(GEN2);
    await expect.poll(() => requests(GEN2)).toEqual(cards);
    await expect(canvas(page)).not.toHaveAttribute("data-preview-product");
    await expect(back).not.toHaveAttribute("data-preview-product");

    // A's cards can decode from browser memory without a second network request.
    await page.evaluate((generation) => {
      const decode = HTMLImageElement.prototype.decode;
      const release = (side: string) => new Promise<void>((resolve) =>
        window.addEventListener(`release-card-${side}`, () => resolve(), { once: true }));
      const front = release("a");
      const back = release("b");
      HTMLImageElement.prototype.decode = async function () {
        const url = new URL(this.src);
        const key = url.pathname.split("/").at(-1) || "";
        if (url.searchParams.get("generation_id") !== generation) return decode.call(this);
        performance.mark(`returned-preview:${key}`);
        const side = /^white_([ab])(?:_set)?_card$/.exec(key)?.[1];
        await Promise.all([decode.call(this), side === "a" ? front : side === "b" ? back : undefined]);
      };
    }, GEN);
    const decoded = () => page.evaluate(() => performance.getEntriesByType("mark")
      .filter(({ name }) => name.startsWith("returned-preview:")).map(({ name }) => name.split(":")[1]).sort());
    const returnStart = urls.length;
    await selectVersion(GEN);
    await expect.poll(decoded).toEqual(expect.arrayContaining(cards));
    await expect(canvas(page)).not.toHaveAttribute("data-preview-product");
    await expect(back).not.toHaveAttribute("data-preview-product");

    await page.evaluate(() => window.dispatchEvent(new Event("release-card-a")));
    await expect(canvas(page)).toHaveAttribute("data-preview-product", "card");
    await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
    await expect(back).not.toHaveAttribute("data-preview-product");
    expect(requests(GEN, returnStart)).not.toContain("glb");
    expect(await decoded()).toEqual(cards);

    await page.evaluate(() => window.dispatchEvent(new Event("release-card-b")));
    await expect.poll(() => requests(GEN, returnStart)).toContain("glb");
    await expect(canvas(page)).toHaveAttribute("data-preview-product", "full");
    await expect(back).toHaveAttribute("data-preview-product", "full");
  } finally {
    secondVersion.release(); model.release();
  }
});

test("同代 card 真正绘制后再升级 full，像素与来源属性一起变", async ({ page, studioFiles }) => {
  const gates: GateMap = {
    white_a: deferred(), white_a_ground: deferred(), white_a_set: deferred(),
    white_b: deferred(), white_b_ground: deferred(), white_b_set: deferred(),
  };
  const { urls } = await serve(page, studioFiles, { gates });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-source", "card");
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
  await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
  (gates.white_a as ReturnType<typeof deferred>).release();
  await expect(shot).toHaveAttribute("data-preview-product", "full");
  await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
  await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
  await expect(shot).toHaveAttribute("data-preview-source", "mixed");
  (gates.white_a_set as ReturnType<typeof deferred>).release();
  await expect(shot).toHaveAttribute("data-preview-set", "full");
  await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08))).toBe(true);
  (gates.white_a_ground as ReturnType<typeof deferred>).release();
  (gates.white_b as ReturnType<typeof deferred>).release();
  (gates.white_b_ground as ReturnType<typeof deferred>).release();
  (gates.white_b_set as ReturnType<typeof deferred>).release();
  await expect(shot).toHaveAttribute("data-preview-source", "full");
  expect(urls.some((url) => url.includes("white_a_card"))).toBe(true);
  expect(urls.filter((url) => url.startsWith("POST:")).length).toBe(0);
});

test("ground 先到与 set pending/失败不挡住产品升级", async ({ page, studioFiles }) => {
  const setCard = deferred();
  const setFull = deferred();
  const gates: GateMap = {
    white_a: deferred(), white_a_ground: "open",
    white_a_set: setFull, white_a_set_card: setCard,
    white_b: "open", white_b_ground: "open",
    white_b_set: "fail", white_b_set_card: "fail",
  };
  await serve(page, studioFiles, { gates });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  await expect(shot).toHaveAttribute("data-preview-set-fetch", "pending");
  await expect(shot).toHaveAttribute("data-preview-set-fallback", "1");
  (gates.white_a as ReturnType<typeof deferred>).release();
  await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
  await expect(shot).toHaveAttribute("data-preview-product", "full");
  await expect(shot).toHaveAttribute("data-preview-set-fetch", "pending");
  setCard.release();
  setFull.release();
  await expect(shot).toHaveAttribute("data-preview-set", "full");
  await expect(shot).not.toHaveAttribute("data-preview-set-fallback", "1");
});

test("full 失败留 card 并提示重开，重新打开会再请求 full", async ({ page, studioFiles }) => {
  const front = { ...deferred(), abort: true };
  const urls: string[] = [];
  await serve(page, studioFiles, {
    urls,
    gates: { white_a: front, white_a_ground: "fail", white_a_set: "fail", white_b: "fail", white_b_ground: "fail", white_b_set: "fail" },
  });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  const shot = canvas(page);
  try {
    await expect(shot).toHaveAttribute("data-preview-product", "card");
  } finally {
    front.release();
  }
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
  await expect(shot).toHaveAttribute("data-preview-product-upgrade", "failed");
  await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
  const productFull = (href: string) => {
    try {
      const path = new URL(href, "http://synthetic.invalid").pathname;
      return path.endsWith("/white_a");
    } catch { return false; }
  };
  const before = urls.filter(productFull).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(canvas(page)).toHaveAttribute("data-preview-product-upgrade", "failed");
  const after = urls.filter(productFull).length;
  expect(after).toBeGreaterThan(before);
  expect(urls.filter((url) => url.startsWith("POST:")).length).toBe(0);
});

test("card 失败回退 full；白底导出不等待 set", async ({ page, studioFiles }) => {
  const set = deferred();
  const { studio } = await serve(page, studioFiles, {
    gates: {
      white_a_card: "fail", white_a_ground_card: "fail", white_a_set_card: "fail",
      white_b_card: "fail", white_b_ground_card: "fail", white_b_set_card: "fail",
      white_a_set: set, white_b_set: set,
    },
  });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
    const shot = canvas(page);
    await expect(shot).toHaveAttribute("data-preview-product", "full");
    await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
    const saved = await download;
    const bytes = readFileSync((await saved.path())!);
    const png = await inspectDownload(page, bytes, 40, 48);
    expect(png.size).toEqual([80, 96]);
    expect(isBlue(png.px)).toBe(true);
    expect(studio.requests).toEqual([studioRequest("white_a", "white", "none")]);
  } finally {
    set.release();
  }
});

test("画面使用地面时，成片接口拒绝请求会报告下载失败，地面预览保留", async ({ page, studioFiles }) => {
  const ground = deferred();
  const unhandled = await trackUnhandled(page);
  const job = jobModel();
  job.files = job.files.filter((file) => !file.key.includes("_set"));
  const { studio } = await serve(page, studioFiles, {
    job, gates: { white_a_ground: ground, white_b_ground: "fail" }, studioPrepare: () => "reject",
  });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
    const shot = canvas(page);
    await expect(shot).toHaveAttribute("data-preview-product", "full");
    await expect(shot).toHaveAttribute("data-preview-ground", "card");
    await expect(shot).toHaveAttribute("data-preview-set-fallback", "1");
    const before = await unhandled.snapshot();
    const status = downloadStatus(page);
    const frozen = studioRequest("white_a", "white_set", "ground");
    await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
    await expect(status).toContainText(STUDIO_DOWNLOAD_FAILED);
    expect((await unhandled.snapshot()).slice(before.length)).toEqual([]);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => studio.requests).toEqual([frozen, frozen]);
    await expect(status).toContainText(STUDIO_DOWNLOAD_FAILED);
    await expect(shot).toHaveAttribute("data-preview-ground", "card");
    expect((await unhandled.snapshot()).slice(before.length)).toEqual([]);
  } finally {
    ground.release();
  }
});

test("成片失败即时报告，不等尚未就绪的布景预览", async ({ page, studioFiles }) => {
  const full = deferred();
  const unhandled = await trackUnhandled(page);
  const { studio } = await serve(page, studioFiles, {
    gates: { white_a: full, white_b: "fail", white_a_set: full, white_b_set: full }, studioPrepare: () => "reject",
  });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
    const shot = canvas(page);
    await expect(shot).toHaveAttribute("data-preview-product", "card");
    await expect(shot).toHaveAttribute("data-preview-set", "card");
    const before = await unhandled.snapshot();
    await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
    await expect(downloadStatus(page)).toContainText(STUDIO_DOWNLOAD_FAILED);
    expect(studio.requests).toEqual([studioRequest("white_a", "white_set", "set")]);
    expect((await unhandled.snapshot()).slice(before.length)).toEqual([]);
  } finally {
    full.release();
  }
});

test("白桌白墙下载不因可选 set pending 挂起", async ({ page, studioFiles }) => {
  const setCard = deferred();
  const setFull = deferred();
  const { studio } = await serve(page, studioFiles, {
    gates: {
      white_a_set: setFull, white_a_set_card: setCard,
      white_b_set: setFull, white_b_set_card: setCard,
    },
  });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-preview-set-fallback", "1");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
    const saved = await download;
    const bytes = readFileSync((await saved.path())!);
    const corner = await inspectDownload(page, bytes, 4, 4);
    const center = await inspectDownload(page, bytes, 40, 48);
    expect(corner.size).toEqual([80, 96]);
    expect(isBlue(center.px)).toBe(true);
    expect(isGroundFallback(corner.px)).toBe(true);
    expect(isMagenta(corner.px)).toBe(false);
    expect(studio.requests).toEqual([studioRequest("white_a", "white_set", "ground")]);
  } finally {
    setCard.release(); setFull.release();
  }
});

test("点一次下载，成片应答后自动保存，不等布景、地面或 GLB", async ({ page, studioFiles }) => {
  test.setTimeout(30_000);
  const response = deferred();
  const pending = deferred();
  const { studio } = await serve(page, studioFiles, {
    gates: { white_a_set: pending, white_a_ground: pending, white_b: pending, white_b_ground: pending, white_b_set: pending, glb: pending },
    studioPrepare: () => response,
  });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
    await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
    const savedFiles: string[] = [];
    page.on("download", (item) => savedFiles.push(item.suggestedFilename()));
    await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
    const status = downloadStatus(page);
    await expect(status).toContainText("正在准备成片");
    const browserState = await page.context().newCDPSession(page);
    try {
      // Playwright evaluate supplies a user gesture. Observe without refreshing it.
      await expect.poll(async () => {
        const { result } = await browserState.send("Runtime.evaluate", {
          expression: "navigator.userActivation.isActive",
          returnByValue: true,
          userGesture: false,
        });
        return result.value;
      }, { timeout: 12_000 }).toBe(false);
    } finally {
      await browserState.detach();
    }
    await expect(status).toContainText("正在准备成片");
    expect(savedFiles).toEqual([]);
    expect(studio.fileRequests).toEqual([]);
    const download = page.waitForEvent("download");
    response.release();
    const saved = await download;
    const bytes = readFileSync((await saved.path())!);
    const corner = await inspectDownload(page, bytes, 4, 4);
    const center = await inspectDownload(page, bytes, 40, 48);
    expect(corner.size).toEqual([80, 96]);
    expect(isBlue(center.px)).toBe(true);
    expect(isCyan(corner.px)).toBe(true);
    expect(isMagenta(corner.px)).toBe(false);
    expect(isGroundFallback(corner.px)).toBe(false);
    expect(savedFiles).toEqual(["white_a.png"]);
    expect(studio.fileRequests).toEqual([new URL(saved.url()).pathname]);
    expect(studio.requests).toEqual([studioRequest("white_a", "white_set", "set")]);
  } finally {
    response.release(); pending.release();
  }
});

test("切白底可单独下载，已点的布景仍按原背景自动保存", async ({ page, studioFiles }) => {
  const setFull = deferred();
  const model = deferred();
  const response = deferred();
  const { urls, studio } = await serve(page, studioFiles, {
    gates: { white_a_set: setFull, white_b_set: setFull, glb: model },
    studioPrepare: ({ layer }) => layer === "set" ? response : "ready",
  });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    const backdrop = page.locator(".mockup-backdrop-switch");
    const button = page.getByRole("button", { name: "下载正面 + 侧面", exact: true });
    await backdrop.getByText("白桌白墙", { exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
    await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
    const previewPaths = () => urls.map((href) => new URL(href).pathname);
    await expect.poll(previewPaths).toContain(`/api/mockups/${ID}/files/white_a_set`);
    await button.click();
    const setRequest = studioRequest("white_a", "white_set", "set");
    await expect.poll(() => studio.requests).toEqual([setRequest]);
    await backdrop.getByText("白底", { exact: true }).click();
    const download = page.waitForEvent("download");
    await button.click();
    const saved = await download;
    const white = await inspectDownload(page, readFileSync((await saved.path())!), 40, 48);
    expect(white.size).toEqual([80, 96]);
    expect(isBlue(white.px)).toBe(true);
    const sceneDownload = page.waitForEvent("download");
    response.release();
    const recovered = await sceneDownload;
    const setPng = await inspectDownload(page, readFileSync((await recovered.path())!), 4, 4);
    expect(setPng.size).toEqual([80, 96]);
    expect(isCyan(setPng.px)).toBe(true);
    expect(isGroundFallback(setPng.px)).toBe(false);
    setFull.release();
    await expect(canvas(page, "反面与侧面成片")).toHaveAttribute("data-preview-product", "full");
    expect(previewPaths()).not.toContain(`/api/mockups/${ID}/files/white_b_set`);
    expect(studio.requests).toEqual([setRequest, studioRequest("white_a", "white", "none")]);
  } finally {
    response.release(); setFull.release(); model.release();
  }
});

test("set full 失败且预览仍是 card 时不导出错误背景", async ({ page, studioFiles }) => {
  const { studio } = await serve(page, studioFiles, {
    gates: { white_a_set: "fail", white_b_set: "fail" }, studioPrepare: () => "reject",
  });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
  const stolen = page.waitForEvent("download", { timeout: 1500 }).then(() => "got").catch(() => "none");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  await expect(downloadStatus(page)).toContainText(STUDIO_DOWNLOAD_FAILED);
  expect(await stolen).toBe("none");
  expect(studio.requests).toEqual([studioRequest("white_a", "white_set", "set")]);
});

test("布景下载失败后可以在同页重试并保存", async ({ page, studioFiles }) => {
  let response: StudioPreparation = "reject";
  const { studio } = await serve(page, studioFiles, {
    gates: { white_a_set: "fail", white_b_set: "fail" }, studioPrepare: () => response,
  });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  const status = downloadStatus(page);
  await expect(status).toContainText(STUDIO_DOWNLOAD_FAILED);
  response = "ready";
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  const saved = await download;
  const corner = await inspectDownload(page, readFileSync((await saved.path())!), 4, 4);
  expect(corner.size).toEqual([80, 96]);
  expect(isCyan(corner.px)).toBe(true);
  const frozen = studioRequest("white_a", "white_set", "set");
  expect(studio.requests).toEqual([frozen, frozen]);
  await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
});

test("灯箱已显示 set full 时下载不跟小预览 fallback 走 ground", async ({ page, studioFiles }) => {
  const setCard = deferred();
  const { studio } = await serve(page, studioFiles, { gates: { white_a_set_card: setCard, white_b_set_card: setCard } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set-fallback", "1");
  await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const box = dialog.locator("canvas");
  await expect.poll(async () => {
    const px = await box.evaluate((node: HTMLCanvasElement) => Array.from(node.getContext("2d")!.getImageData(4, 4, 1, 1).data));
    return isCyan(px);
  }).toBe(true);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载", exact: true }).click();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const corner = await inspectDownload(page, bytes, 4, 4);
  const center = await inspectDownload(page, bytes, 40, 48);
  expect(corner.size).toEqual([80, 96]);
  expect(isBlue(center.px)).toBe(true);
  expect(isCyan(corner.px)).toBe(true);
  expect(isGroundFallback(corner.px)).toBe(false);
  expect(studio.requests).toEqual([studioRequest("white_a", "white_set", "set")]);
  setCard.release();
});

test("灯箱正在显示 ground fallback 时，隐藏预览迟到的 set card 不改变下载背景", async ({ page, studioFiles }) => {
  const setCard = deferred();
  const setFull = deferred();
  const unhandled = await trackUnhandled(page);
  const { studio } = await serve(page, studioFiles, { gates: {
    white_a_set_card: setCard, white_b_set_card: setCard,
    white_a_set: setFull, white_b_set: setFull,
  } });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-preview-set-fallback", "1");
    await expect(canvas(page)).toHaveAttribute("data-preview-ground", "full");
    await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const box = dialog.locator("canvas");
    const shownCorner = () => box.evaluate((node: HTMLCanvasElement) => Array.from(node.getContext("2d")!.getImageData(4, 4, 1, 1).data));
    await expect.poll(async () => isGroundFallback(await shownCorner())).toBe(true);
    setCard.release();
    await expect(page.locator("canvas.mockup-studio-canvas").first()).toHaveAttribute("data-preview-set", "card");
    expect(isGroundFallback(await shownCorner())).toBe(true);
    const download = page.waitForEvent("download", { timeout: 5000 });
    await dialog.getByRole("button", { name: "下载", exact: true }).click();
    const saved = await download;
    const bytes = readFileSync((await saved.path())!);
    expect(isGroundFallback((await inspectDownload(page, bytes, 4, 4)).px)).toBe(true);
    expect(isBlue((await inspectDownload(page, bytes, 40, 48)).px)).toBe(true);
    expect(studio.requests).toEqual([studioRequest("white_a", "white_set", "ground")]);
    expect(await unhandled.snapshot()).toEqual([]);
  } finally {
    setCard.release(); setFull.release();
  }
});

test("下载中重复点击、切背景或调灯仍只导出点击时的成片，卸载无未处理拒绝", async ({ page, studioFiles }) => {
  const response = deferred();
  const unhandled = await trackUnhandled(page);
  const downloaded: string[] = [];
  page.on("download", (item) => downloaded.push(item.suggestedFilename()));
  const { studio } = await serve(page, studioFiles, { studioPrepare: () => response });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
    await page.getByRole("button", { name: "调灯", exact: true }).click();
    const download = page.waitForEvent("download");
    const button = page.getByRole("button", { name: "下载正面 + 侧面", exact: true });
    const frozen = studioRequest("white_a", "white", "none");
    await button.click();
    await expect.poll(() => studio.requests).toEqual([frozen]);
    await expect(button).toBeDisabled();
    await button.press("Enter");
    await page.locator(".mockup-backdrop-switch").getByText("银底", { exact: true }).click();
    await page.getByRole("slider", { name: "产品灯光", exact: true }).press("Home");
    await page.getByRole("slider", { name: "背景灯光", exact: true }).press("Home");
    await expect(page.getByRole("slider", { name: "产品灯光", exact: true })).toHaveValue("0.6");
    await expect(page.getByRole("slider", { name: "背景灯光", exact: true })).toHaveValue("0.6");
    await page.getByRole("button", { name: "3D 打样", exact: true }).click();
    response.release();
    const saved = await download;
    const bytes = readFileSync((await saved.path())!);
    const center = await inspectDownload(page, bytes, 40, 48);
    const corner = await inspectDownload(page, bytes, 4, 4);
    expect(center.size).toEqual([80, 96]);
    expect(center.px).toEqual([0, 15, 234, 255]);
    expect(corner.px).toEqual([238, 238, 238, 255]);
    expect(studio.requests).toEqual([frozen]);
    expect(downloaded).toEqual(["white_a.png"]);
    expect(await unhandled.snapshot()).toEqual([]);
  } finally {
    response.release();
  }
});

test("已启动下载在预览卸载后仍完成", async ({ page, studioFiles }) => {
  const full = deferred();
  const response = deferred();
  const { studio } = await serve(page, studioFiles, { gates: { white_a: full, white_b: full }, studioPrepare: () => response });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-preview-product", "card");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
    await expect.poll(() => studio.requests).toEqual([studioRequest("white_a", "white", "none")]);
    await page.getByRole("button", { name: "3D 打样", exact: true }).click();
    response.release();
    const saved = await download;
    const bytes = readFileSync((await saved.path())!);
    const center = await inspectDownload(page, bytes, 40, 48);
    expect(center.size).toEqual([80, 96]);
    expect(isBlue(center.px)).toBe(true);
  } finally {
    response.release(); full.release();
  }
});

test("准备时关掉标签页，回到同一打样可取回同一张成片", async ({ page, context, studioFiles }) => {
  const response = deferred();
  const { studio } = await serve(context, studioFiles, { studioPrepare: () => response });
  const detail = `/mockup/${ID}`;
  const base = `/api/mockups/${ID}/studio-downloads`;
  try {
    await page.goto(detail, { waitUntil: "domcontentloaded" });
    await expect(canvas(page)).toHaveAttribute("data-preview-set", /card|full/);
    const created = page.waitForResponse((reply) =>
      new URL(reply.url()).pathname === base && reply.request().method() === "POST");
    await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
    const accepted = await created;
    expect(accepted.status()).toBe(202);
    const record: unknown = await accepted.json();
    if (!record || typeof record !== "object" || !("id" in record) || typeof record.id !== "string") {
      throw new Error("成片准备应答缺少记录 ID");
    }
    const href = `${base}/${record.id}/file`;
    await expect(downloadStatus(page)).toHaveText("正在准备成片");
    await page.close();

    const reopened = await context.newPage();
    const browserDownloads: string[] = [];
    reopened.on("download", (download) => browserDownloads.push(download.url()));
    await reopened.goto(detail, { waitUntil: "domcontentloaded" });
    await expect(downloadStatus(reopened)).toHaveText("正在准备成片");
    expect(studio.fileRequests).toEqual([]);
    response.release();

    const ready = downloadCard(reopened, "正面 + 侧面").getByRole("link", { name: /下载成片/ });
    await expect(downloadStatus(reopened)).toHaveText("成片已就绪");
    await expect(ready).toHaveAttribute("href", href);
    await reopened.reload({ waitUntil: "domcontentloaded" });
    await expect(ready).toHaveAttribute("href", href);
    expect(browserDownloads).toEqual([]);
    expect(studio.fileRequests).toEqual([]);

    const download = reopened.waitForEvent("download");
    await ready.click();
    const saved = await download;
    const selection = studioRequest("white_a", "white_set", "set");
    expect(studio.requests).toEqual([selection]);
    expect(studio.fileRequests).toEqual([href]);
    expect(browserDownloads).toEqual([new URL(href, reopened.url()).href]);
    expect(saved.suggestedFilename()).toBe("white_a.png");
    expect(readFileSync((await saved.path())!)).toEqual(studioPng(selection, 80, 96));
  } finally {
    response.release();
  }
});

test("原图灯箱用 full 像素，不截预览 canvas", async ({ page, studioFiles }) => {
  await serve(page, studioFiles, {});
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = dialog.locator("canvas");
  await expect.poll(async () => box.evaluate((node: HTMLCanvasElement) => node.width)).toBe(80);
  await expect.poll(async () => {
    const px = await box.evaluate((node: HTMLCanvasElement) => Array.from(node.getContext("2d")!.getImageData(40, 48, 1, 1).data));
    return isBlue(px);
  }).toBe(true);
});

test("resize 后仍保持已绘制来源标记", async ({ page, studioFiles }) => {
  await serve(page, studioFiles, {});
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-source", /card|mixed|full/);
  const before = await shot.evaluate((node: HTMLCanvasElement) => node.width);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => shot.evaluate((node: HTMLCanvasElement) => node.width)).not.toBe(before);
  await expect(shot).toHaveAttribute("data-preview-source", /card|mixed|full/);
});

test("代表尺寸 PNG：记录 card 可见、full decode 与绘制", async ({ browser, browserName, baseURL, studioFiles }, testInfo) => {
  test.setTimeout(180_000);
  const card = pngFill(1200, 1440, [0, 0, 0, 0], { x: 300, y: 360, w: 600, h: 720, color: [200, 0, 0, 255] });
  const full = pngFill(3000, 3600, [0, 0, 0, 0], { x: 750, y: 900, w: 1500, h: 1800, color: [0, 20, 230, 255] });
  const groundCard = pngFill(1200, 1440, [0, 160, 0, 255]);
  const groundFull = pngFill(3000, 3600, [200, 200, 0, 255]);
  const setCard = pngFill(1200, 1440, [200, 0, 200, 255]);
  const setFull = pngFill(3000, 3600, [0, 200, 200, 255]);
  const pngs = new Map<string, Buffer>([
    ["product:card", card], ["product:full", full],
    ["ground:card", groundCard], ["ground:full", groundFull],
    ["set:card", setCard], ["set:full", setFull],
  ]);
  const samples: Array<Record<string, unknown>> = [];
  let userAgent = "";
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ baseURL, deviceScaleFactor: dpr, viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => { (window as Window & { __RF09_PERF__?: boolean }).__RF09_PERF__ = true; });
    const page = await context.newPage();
    userAgent = await page.evaluate(() => navigator.userAgent);
    for (let i = 0; i < 3; i++) {
      await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
      const gates: GateMap = {
        white_a: deferred(), white_b: deferred(),
        white_a_ground: deferred(), white_b_ground: deferred(),
        white_a_set: deferred(), white_b_set: deferred(),
      };
      await serve(page, studioFiles, { gates, pngs });
      const t0 = Date.now();
      await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
      await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
      const shot = canvas(page);
      await expect(shot).toHaveAttribute("data-preview-product", "card");
      const tCard = Date.now() - t0;
      await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
      const tCardPx = Date.now() - t0;
      const netFull = Date.now();
      (gates.white_a as ReturnType<typeof deferred>).release();
      (gates.white_b as ReturnType<typeof deferred>).release();
      (gates.white_a_ground as ReturnType<typeof deferred>).release();
      (gates.white_b_ground as ReturnType<typeof deferred>).release();
      (gates.white_a_set as ReturnType<typeof deferred>).release();
      (gates.white_b_set as ReturnType<typeof deferred>).release();
      await expect(shot).toHaveAttribute("data-preview-product", "full");
      const tProductFullAttr = Date.now() - netFull;
      await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
      const tProductFullPx = Date.now() - netFull;
      await expect(shot).toHaveAttribute("data-preview-set", "full");
      await expect(shot).toHaveAttribute("data-preview-source", "full");
      await expect(canvas(page, "反面与侧面成片")).toHaveAttribute("data-preview-source", "full");
      await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08))).toBe(true);
      await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08, "反面与侧面成片"))).toBe(true);
      const tCompositeFullPx = Date.now() - netFull;
      const marks = await page.evaluate(() => performance.getEntriesByType("mark").map((entry) => ({ name: entry.name, startTime: Math.round(entry.startTime) })));
      const size = await shot.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height, css: { w: node.clientWidth, h: node.clientHeight } }));
      const observedDpr = await page.evaluate(() => window.devicePixelRatio);
      samples.push({
        dpr: observedDpr, i,
        tCardMs: tCard, tCardPixelMs: tCardPx,
        tProductFullAttrMs: tProductFullAttr, tProductFullPxMs: tProductFullPx,
        tCompositeFullPxMs: tCompositeFullPx,
        canvas: size, marks, cache: i === 0 ? "cold-page" : "repeat-navigation",
        source: { full: [3000, 3600], card: [1200, 1440] },
        hasSetFullMark: marks.some((entry) => entry.name === "rf09-decode-set-full"),
      });
    }
    await context.close();
  }
  const payload = {
    recorded_at: new Date().toISOString(),
    browser: browserName,
    userAgent,
    viewport: { width: 1440, height: 900 },
    fixture: "synthetic-png-3000x3600-alpha-product",
    note: "API 拦截本地 PNG，不计杭州网络。tProductFull* 只描述 product 层；tCompositeFullPxMs 等到两张成片 data-preview-source=full 且背景 set 像素。heap 未测。没有同环境修改前浏览器计时，不能据此声称无首屏回退或性能无异常。",
    adr_17_4: "网络完成后仍需 decode；decode 就绪后下一可用绘制机会替换。marks 仅在 window.__RF09_PERF__ 时写入，每名最多 24 条。不声称 rAF 等于屏幕合成时刻。",
    samples,
  };
  const out = testInfo.outputPath("rf09-preview-measure.json");
  writeFileSync(out, JSON.stringify(payload, null, 2));
  testInfo.attach("rf09-preview-measure", { path: out });
  if (MEASURE_DIR) {
    try {
      mkdirSync(MEASURE_DIR, { recursive: true });
      writeFileSync(join(MEASURE_DIR, "rf09-preview-measure-20260907.json"), JSON.stringify(payload, null, 2));
    } catch {
      /* audit copy is optional */
    }
  }
  expect(samples.length).toBe(6);
  expect(samples.every((row) => row.hasSetFullMark)).toBe(true);
});

test("Q05 切代/resize/离页：记录 heap 与 rAF 间隔，不把 rAF 当成屏幕合成时刻", async ({ page, browserName, studioFiles }, testInfo) => {
  test.setTimeout(180_000);
  const pngs = new Map<string, Buffer>([
    ["product:card", pngFill(1200, 1440, [0, 0, 0, 0], { x: 300, y: 360, w: 600, h: 720, color: [200, 0, 0, 255] })],
    ["product:full", pngFill(3000, 3600, [0, 0, 0, 0], { x: 750, y: 900, w: 1500, h: 1800, color: [0, 20, 230, 255] })],
    ["ground:card", pngFill(1200, 1440, [0, 160, 0, 255])],
    ["ground:full", pngFill(3000, 3600, [200, 200, 0, 255])],
    ["set:card", pngFill(1200, 1440, [200, 0, 200, 255])],
    ["set:full", pngFill(3000, 3600, [0, 200, 200, 255])],
  ]);
  const job = jobModel();
  job.has_render_generations = true;
  job.render_generation_capabilities = {
    history: { allowed: true },
    activate: { allowed: true },
    legacy_relight: { allowed: true },
    upgrade: { allowed: false, reason: "upgrade_unwired" },
  };
  const history: RenderGenerationRow[] = [
    { generation_id: GEN, mode: "legacy_relight", profile: "synthetic", quality_status: "unwired", created_at: "2026-09-08T00:00:00Z", current: true },
    { generation_id: GEN2, mode: "legacy_relight", profile: "synthetic", quality_status: "unwired", created_at: "2026-09-08T00:01:00Z", current: false },
  ];
  await page.addInitScript(() => { (window as Window & { __RF09_PERF__?: boolean }).__RF09_PERF__ = true; });
  const heap = await q05AttachHeap(page);
  const stages: Array<Record<string, unknown>> = [];
  const gates: GateMap = {
    white_a: deferred(), white_b: deferred(),
    white_a_ground: deferred(), white_b_ground: deferred(),
    white_a_set: deferred(), white_b_set: deferred(),
  };
  await serve(page, studioFiles, { pngs, job, history, gates, studioSize: [3000, 3600] });
  const t0 = Date.now();
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  const tCard = Date.now() - t0;
  await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
  const tCardPx = Date.now() - t0;
  stages.push({
    phase: "card-visible",
    tCardMs: tCard,
    tCardPxMs: tCardPx,
    heap: await heap.sample(false),
    note: "card 已绘制；full 仍 gated。t* 是 DOM/canvas 采样，不是屏幕合成精确时刻",
  });

  const netFull = Date.now();
  (gates.white_a as ReturnType<typeof deferred>).release();
  (gates.white_b as ReturnType<typeof deferred>).release();
  (gates.white_a_ground as ReturnType<typeof deferred>).release();
  (gates.white_b_ground as ReturnType<typeof deferred>).release();
  (gates.white_a_set as ReturnType<typeof deferred>).release();
  (gates.white_b_set as ReturnType<typeof deferred>).release();
  await expect(shot).toHaveAttribute("data-preview-product", "full");
  const tProductFullAttr = Date.now() - netFull;
  const marksAtAttr = await page.evaluate(() => performance.getEntriesByType("mark").map((entry) => ({ name: entry.name, startTime: Math.round(entry.startTime) })));
  stages.push({
    phase: "full-decode-attr",
    tProductFullAttrMs: tProductFullAttr,
    marks: marksAtAttr,
    heap: await heap.sample(false),
    note: "dataset 已是 full；网络在本机拦截中约等于 0，此段主要是 decode + React 发布",
  });
  await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
  await expect(shot).toHaveAttribute("data-preview-source", "full");
  const tProductFullPx = Date.now() - netFull;
  stages.push({
    phase: "full-replace-px",
    tProductFullPxMs: tProductFullPx,
    heap: await heap.sample(false),
    heapAfterGc: await heap.sample(true),
    note: "像素已替换。heapAfterGc 仍不是 GPU 纹理证明",
  });

  await page.getByRole("button", { name: "出图版本", exact: true }).click();
  for (const [from, to] of [[GEN, GEN2], [GEN2, GEN], [GEN, GEN2]] as const) {
    await page.locator(`[data-generation-id="${to}"]`).getByRole("button", { name: "使用此版本" }).click();
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation", to);
    await expect(shot).toHaveAttribute("data-preview-product", /card|full/);
    await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
    stages.push({
      phase: `switch-${from}-to-${to}`,
      heap: await heap.sample(false),
      heapAfterGc: await heap.sample(true),
      note: "同 fixture 切代；cache 应按 asset path 淘汰旧代，不得按次数单调增长",
    });
  }

  await page.evaluate(() => {
    const w = window as Window & { __q05Frames?: number[]; __q05RafOn?: boolean };
    w.__q05Frames = [];
    w.__q05RafOn = true;
    let last = 0;
    const tick = (now: number) => {
      if (!w.__q05RafOn) return;
      if (last) w.__q05Frames!.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(180);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(180);
  const frameDts = await page.evaluate(() => {
    const w = window as Window & { __q05Frames?: number[]; __q05RafOn?: boolean };
    w.__q05RafOn = false;
    return w.__q05Frames || [];
  });
  const longFrames = frameDts.filter((dt) => dt > 32);
  stages.push({
    phase: "resize",
    heap: await heap.sample(false),
    rafDtMs: frameDts.slice(0, 48),
    rafCount: frameDts.length,
    rafMaxMs: frameDts.reduce((max, dt) => Math.max(max, dt), 0),
    rafLongOver32ms: longFrames.length,
    canvas: await shot.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height, cssW: node.clientWidth, cssH: node.clientHeight })),
    note: "rAF 间隔在 resize 期间采集；是脚本调度，不是 GPU 上屏时刻",
  });

  await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = dialog.locator("canvas");
  await expect.poll(async () => box.evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(0);
  stages.push({
    phase: "lightbox-open",
    heap: await heap.sample(false),
    lightbox: await box.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height })),
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  stages.push({
    phase: "lightbox-closed",
    heap: await heap.sample(false),
    heapAfterGc: await heap.sample(true),
  });

  const beforeDownload = await heap.sample(true);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const size: [number, number] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  stages.push({
    phase: "download",
    heapBeforeGc: beforeDownload,
    heap: await heap.sample(false),
    heapAfterGc: await heap.sample(true),
    download: { bytes: bytes.length, size, pngSignature: bytes[0] === 137 },
    note: "下载尺寸用 Node IHDR，避免把 PNG 送回页面污染 heap。",
  });
  expect(size).toEqual([3000, 3600]);

  await page.goto("about:blank");
  await page.waitForTimeout(250);
  stages.push({
    phase: "left-page",
    heap: await heap.sample(false),
    heapAfterGc: await heap.sample(true),
    note: "离页后 JS heap 不一定立即回收；cache probe 在 blank 页应为 0 或 probe=false。不能据此宣称已释放 GPU 纹理",
  });

  const cacheSizes = stages
    .map((row) => {
      const heapRow = (row.heapAfterGc || row.heap) as { cache?: { size: number | null } } | undefined;
      return typeof heapRow?.cache?.size === "number" ? heapRow.cache.size : null;
    })
    .filter((size): size is number => size != null);
  const payload = {
    recorded_at: new Date().toISOString(),
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: UI_ROOT, encoding: "utf8" }).trim(),
    browser: browserName,
    userAgent: await page.evaluate(() => navigator.userAgent).catch(() => ""),
    viewport: { width: 1440, height: 900, dpr: 1 },
    fixture: "synthetic-png-card-1200x1440-full-3000x3600-alpha-product",
    machine: q05Machine(),
    artifact: {
      mode: artifact?.mode ?? "built-temp",
      env: Q05_PREBUILT_ENV,
      identity_file: Q05_IDENTITY_FILE,
      dir: artifact?.mode === "prebuilt-external" ? artifact.dir : null,
      ownedByThisRun: artifact?.owned ?? false,
      files: artifact?.artifactFiles ?? null,
      inputsSha: artifact?.inputsSha ?? null,
      artifactSha: artifact?.artifactSha ?? null,
      identity: artifact?.identity ?? null,
      note: artifact?.mode === "prebuilt-external"
        ? "BEIAN_Q05_DIST 只读复用外部构建产物：本次运行不构建，也不删除该目录；sidecar 身份必须匹配当前源码/配置/依赖。"
        : "默认模式：beforeAll 在自建临时目录内构建、写入 sidecar，afterAll 只删该临时目录。",
    },
    sources: {
      mockupStudio: fileSha("src/pages/mockupStudio.ts"),
      mockupPage: fileSha("src/pages/MockupPage.tsx"),
      thisSpec: fileSha("e2e/mockup-preview-upgrade.spec.ts"),
    },
    method: `Playwright Chromium + 页面/API 全拦截，不经 Vite/Hono/杭州/真实稿。构建产物来源：${
      artifact?.mode === "prebuilt-external" ? `外部预构建目录（${Q05_PREBUILT_ENV}）` : "本 spec 自建临时目录"
    }。CDP HeapProfiler.collectGarbage + Runtime.getHeapUsage。heap/rAF 在用例内采样，不含 beforeAll 构建。`,
    measurement_windows: artifact ? q05MeasurementWindows(artifact) : null,
    intervals: {
      in_case: "heap/rAF 只在用例内按阶段采样，采样区间不含 beforeAll 的构建，也不含此前准备。",
      whole_command: artifact?.mode === "prebuilt-external"
        ? "整条命令的墙钟/RSS 不含本次 UI 构建，仍含 Chromium/Playwright，不能当浏览器峰值或正式预算。"
        : "整条命令的墙钟/RSS 含 beforeAll 构建，不能直接与预构建模式对比，也不能当浏览器峰值。",
    },
    disclaimer: "本机合成性能不代表杭州或真实用户。DOM/rAF/CDP heap 不是屏幕合成精确时刻，也不是 GPU 纹理占用。",
    adr_17_4: "网络完成后仍需 decode；decode 就绪后下一可用绘制机会替换。不声称 rAF 等于屏幕合成时刻。",
    stages,
  };
  const out = testInfo.outputPath("q05-heap-raf.json");
  writeFileSync(out, JSON.stringify(payload, null, 2));
  testInfo.attach("q05-heap-raf", { path: out });
  if (MEASURE_DIR) {
    mkdirSync(MEASURE_DIR, { recursive: true });
    writeFileSync(join(MEASURE_DIR, "q05-heap-raf.json"), JSON.stringify(payload, null, 2));
  }
  expect(stages.some((row) => row.phase === "card-visible")).toBe(true);
  expect(stages.some((row) => row.phase === "full-replace-px")).toBe(true);
  expect(stages.some((row) => row.phase === "lightbox-open")).toBe(true);
  expect(stages.some((row) => row.phase === "download")).toBe(true);
  expect(stages.some((row) => row.phase === "left-page")).toBe(true);
  expect(size).toEqual([3000, 3600]);
  if (cacheSizes.length >= 2) {
    const peak = Math.max(...cacheSizes);
    expect(peak).toBeLessThan(40);
  }
});
