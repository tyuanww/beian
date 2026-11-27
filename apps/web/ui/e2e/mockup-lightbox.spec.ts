import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeTests } from "@playwright/test";
import { expect, test as syntheticTest } from "./fixtures";
import { studioDownloadTest } from "./fixtures/nativeStudioFiles";
import { pngFill } from "./fixtures/pngFixture";
import { studioDownloadsFixture } from "./fixtures/studioDownloadsFixture";
import type { MockupJob } from "../src/api";

const test = mergeTests(syntheticTest, studioDownloadTest);
let dist: string;
test.beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "beian-lightbox-e2e-"));
  execFileSync("npm", ["run", "build", "--", "--outDir", dist], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 60_000, stdio: "pipe",
  });
});
test.afterAll(() => { if (dist) rmSync(dist, { recursive: true }); });

test("旧单加载中可从灯箱下载，图片就绪后灯箱自动绘制", async ({ page, syntheticApi, studioFiles }) => {
  // Intercept app and API requests. Serve only the synthetic attachment over loopback.
  const assets = new Map<string, Buffer>([["/mockup/aaaaaaaaaaaa", readFileSync(join(dist, "index.html"))]]);
  for (const name of readdirSync(join(dist, "assets"))) {
    assets.set(`/assets/${name}`, readFileSync(join(dist, "assets", name)));
  }
  const generation = "2026-09-06T10:00:00Z";
  const job = {
    id: "aaaaaaaaaaaa", title: "SYNTHETIC legacy lightbox", status: "done", job_finished_at: generation,
    files: [{ key: "white_a", name: "front.png" }, { key: "white_b", name: "back.png" }],
  } satisfies MockupJob;
  syntheticApi.mockups.push(job);
  const png = pngFill(40, 50, [255, 0, 0, 255]);
  const studio = studioDownloadsFixture({ jobId: job.id, files: studioFiles, png: () => png, filename: () => "front.png" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (studio.matches(path)) return studio.handle(route);
    if (/\/files\/white_[ab]$/.test(path)) {
      await gate;
      return route.fulfill({ contentType: "image/svg+xml", body:
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50"><rect width="40" height="50" fill="red"/></svg>' });
    }
    if (path.startsWith("/api/")) return route.fallback();
    const body = assets.get(path);
    if (!body) return route.fulfill({ status: 404, body: "synthetic asset not supplied" });
    const contentType = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
    return route.fulfill({ body, contentType });
  });
  try {
    await page.goto("/mockup/aaaaaaaaaaaa", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("slider", { name: "产品灯光" }).fill("1.2");
    await dialog.getByRole("slider", { name: "背景灯光" }).fill("0.8");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载", exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("front.png");
    expect(readFileSync((await saved.path())!)).toEqual(png);
    expect(studio.requests).toEqual([
      { file_key: "white_a", generation, backdrop: "white_set", layer: "none", product_light: 1.2, background_light: 0.8 },
    ]);
    expect(studio.fileRequests).toEqual([new URL(saved.url()).pathname]);
    release();
    const canvas = dialog.locator("canvas");
    await expect(canvas).toHaveAttribute("width", "40");
    await expect(canvas).toHaveAttribute("height", "50");
    expect(await canvas.evaluate((node: HTMLCanvasElement) =>
      Array.from(node.getContext("2d")!.getImageData(20, 25, 1, 1).data))).toEqual([255, 0, 0, 255]);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});
