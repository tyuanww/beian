import { completedMockup, expect, test } from "./fixtures";
import type { CompressionBatch } from "../src/batchTypes";

const id = "abcdef123456";
const faceImage = "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='600'><rect width='400' height='600' fill='white'/></svg>";
const printFaces = ["front", "back", "left", "right", "top", "bottom"].map(face => ({ key: `read_${face}`, name: `panel_${face}.png` }));
function batch(): CompressionBatch {
  return { id, title: "海葡萄备案资料", created_at: "2026-10-09T08:00:00Z", revision: 1, status: "partial", owner: "合成用户", creator_id: "ou_e2e_synthetic", queue_ahead: 0, files: [
    { id: "asset1", name: "实拍图.pdf", media_type: "application/pdf", status: "succeeded", input_bytes: 24_000_000, output_bytes: 8_200_000, target_bytes: 10_000_000, reason: null, message: "已达到目标", can_retry: false, key: "file-asset1" },
    { id: "asset2", name: "检测报告.pdf", media_type: "application/pdf", status: "unmet_target", input_bytes: 34_000_000, output_bytes: null, target_bytes: 10_000_000, reason: "unmet_target", message: "未达到目标，保留原文件", can_retry: true },
  ] };
}

test("压缩上传复用分片 receipt，刷新详情并只重试服务端允许的项", async ({ page, syntheticApi }, info) => {
  let current = batch();
  let startBody: unknown;
  let retryBody: unknown;
  await page.route("**/api/compressions/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/start")) startBody = route.request().postDataJSON();
    if (path.endsWith("/retry")) {
      retryBody = route.request().postDataJSON();
      current = { ...current, status: "running", revision: 2, files: current.files.map(file => file.id === "asset2" ? { ...file, status: "running", can_retry: false } : file) };
    }
    await route.fulfill({ status: route.request().method() === "POST" ? 202 : 200, contentType: "application/json", body: JSON.stringify(current) });
  });
  await page.goto("/compress");
  await page.getByLabel("选择压缩文件").setInputFiles([{ name: "seal.pdf", mimeType: "application/pdf", buffer: Buffer.from("synthetic pdf only") }]);
  const detailResponse = page.waitForResponse(response => response.url().endsWith(`/api/compressions/${id}`));
  await page.getByRole("button", { name: "上传并压缩" }).click();
  await expect(page).toHaveURL(`/compress/${id}`);
  await expect((await detailResponse).status()).toBe(200);
  expect(startBody).toHaveProperty("receipt");
  const session = syntheticApi.calls.find(call => call.path === "/api/uploads/sessions");
  expect(session?.body).toHaveProperty("purpose", "compression");
  expect(syntheticApi.calls.some(call => call.path.endsWith("/files/asset1"))).toBe(true);
  await expect(page.getByRole("heading", { name: "海葡萄备案资料" })).toBeVisible();
  await expect(page.getByText("8.20 MB")).toBeVisible();
  await page.screenshot({ path: info.outputPath("compression-desktop.png"), fullPage: true });
  await expect(page.getByText("未生成", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /下载结果\s*ZIP/ })).toHaveAttribute("href", `/api/compressions/${id}/zip`);
  await page.reload();
  await expect(page.getByText("检测报告.pdf", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试失败项" }).click();
  expect(retryBody).toEqual({ expected_revision: 1, file_ids: ["asset2"] });
  await expect(page.getByRole("button", { name: /下载结果\s*ZIP/ })).toBeDisabled();
});

test("净版七标签显示关闭未确认，并复用一次请求", async ({ page, syntheticApi }) => {
  const job = completedMockup(id, "净版展开合成盒"); job.files = [];
  Object.assign(job, { unfolded_print: { status: "unavailable" }, print_faces_zip: { status: "incomplete", reason: "faces_incomplete" } });
  syntheticApi.mockups.push(job);
  let posts = 0;
  await page.route(`**/api/mockups/${id}/unfolded-print`, async route => {
    posts++;
    Object.assign(job, { unfolded_print: { status: "running", reason: "close_unconfirmed" } });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(job) });
  });
  await page.goto(`/mockup/${id}`);
  const printTab = page.getByRole("tab", { name: "印刷面", exact: true });
  await printTab.click();
  const read = page.getByRole("region", { name: "印刷面", exact: true });
  const tabs = read.getByRole("tab");
  await expect(tabs).toHaveText(["2D 展开图", "正面", "反面", "左侧", "右侧", "顶部", "底部"]);
  await expect(read.getByRole("tab", { name: "2D 展开图" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "展开图" }).getByRole("heading", { name: "展开图" })).toBeVisible();
  await page.getByRole("button", { name: "生成展开图" }).click();
  await expect(page.getByText("展开图还在生成，请稍后查看。")).toBeVisible();
  await expect(page.getByText("可以离开页面，回来后再看结果。")).toBeVisible();
  await expect(page.getByRole("button", { name: "正在生成" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下载六面" })).toBeDisabled();
  await page.reload();
  await printTab.click();
  await expect(page.getByText("展开图还在生成，请稍后查看。")).toBeVisible();
  expect(posts).toBe(1);
});

test("等待净版时可以继续读正面，净版完成不切走当前视图", async ({ page, syntheticApi }) => {
  const job = completedMockup(id, "净版生成中的读字样例");
  job.files = printFaces;
  Object.assign(job, { unfolded_print: { status: "running" } });
  syntheticApi.mockups.push(job);
  await page.route(`**/api/mockups/${id}/files/read_front`, route => route.fulfill({ contentType: "image/svg+xml", body: faceImage }));
  await page.route(`**/api/mockups/${id}/files/unfolded_print`, route => route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n%%EOF" }));
  await page.goto(`/mockup/${id}`);
  await page.getByRole("tab", { name: "印刷面", exact: true }).click();
  const read = page.getByRole("region", { name: "印刷面", exact: true });
  const frame = read.getByRole("region", { name: "查看正面印刷面", exact: true });
  await expect(frame.getByRole("img", { name: "正面印刷面" })).toBeVisible();
  await frame.focus();
  Object.assign(job, {
    unfolded_print: { status: "ready", file_key: "unfolded_print", width_mm: 420, height_mm: 280 },
    print_faces_zip: { status: "ready", file_key: "print_faces_zip" },
  });
  await expect(read.getByRole("link", { name: "下载六面" })).toBeVisible();
  await expect(frame).toBeFocused();
  await expect(read.getByRole("tab", { name: "正面", exact: true })).toHaveAttribute("aria-selected", "true");
  await read.getByRole("tab", { name: "2D 展开图" }).click();
  await expect(read.getByRole("link", { name: "下载 PDF" })).toBeVisible();
});

test("请求响应丢失后已生成的净版不显示旧错误", async ({ page, syntheticApi }) => {
  const job = completedMockup(id, "净版响应丢失样例");
  job.files = [];
  Object.assign(job, { unfolded_print: { status: "unavailable" } });
  syntheticApi.mockups.push(job);
  await page.route(`**/api/mockups/${id}/unfolded-print`, async (route) => {
    Object.assign(job, { unfolded_print: { status: "ready", file_key: "unfolded_print", width_mm: 420, height_mm: 280 } });
    await route.abort();
  });
  await page.route(`**/api/mockups/${id}/files/unfolded_print`, route => route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n%%EOF" }));
  await page.goto(`/mockup/${id}`);
  await page.getByRole("tab", { name: "印刷面", exact: true }).click();
  const unfolded = page.getByRole("region", { name: "展开图", exact: true });
  await unfolded.getByRole("button", { name: "生成展开图" }).click();
  await expect(unfolded.getByRole("link", { name: "下载 PDF" })).toBeVisible();
  await expect(unfolded.getByRole("alert")).toHaveCount(0);
});

test("净版展示毫米和两个独立下载键；变更后不展示旧 PDF", async ({ page, syntheticApi }) => {
  const job = completedMockup(id, "可打印展开");
  job.files = printFaces;
  Object.assign(job, { unfolded_print: { status: "ready", file_key: "unfolded_print", width_mm: 420, height_mm: 280 }, print_faces_zip: { status: "ready", file_key: "print_faces_zip" } });
  syntheticApi.mockups.push(job);
  await page.route(`**/api/mockups/${id}/files/unfolded_print`, route => route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n%%EOF" }));
  await page.route(`**/api/mockups/${id}/files/read_back`, route => route.fulfill({ contentType: "image/svg+xml", body: faceImage }));
  await page.goto(`/mockup/${id}`);
  const printTab = page.getByRole("tab", { name: "印刷面", exact: true });
  const read = page.getByRole("region", { name: "印刷面", exact: true });
  const unfoldedTab = read.getByRole("tab", { name: "2D 展开图" });
  await printTab.click();
  await expect(unfoldedTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("420 × 280 mm · 1:1")).toBeVisible();
  await expect(page.getByTitle("展开图预览")).toHaveAttribute("src", `/api/mockups/${id}/files/unfolded_print`);
  await expect(page.getByRole("link", { name: "下载 PDF" })).toHaveAttribute("href", `/api/mockups/${id}/files/unfolded_print?download=1`);
  await expect(page.getByRole("link", { name: "下载六面" })).toHaveAttribute("href", `/api/mockups/${id}/files/print_faces_zip?download=1`);
  job.files = printFaces.filter(file => file.key === "read_back");
  Object.assign(job, { unfolded_print: { status: "failed", reason: "source_changed" }, print_faces_zip: { status: "incomplete", reason: "faces_incomplete" } });
  await page.reload();
  await printTab.click();
  await expect(read.getByRole("tab", { name: "反面", exact: true })).toHaveAttribute("aria-selected", "true");
  await unfoldedTab.click();
  await expect(page.getByTitle("展开图预览")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载 PDF" })).toHaveCount(0);
  await expect(page.getByText("源稿已变化，请重新生成展开图。")).toBeVisible();
});

for (const reason of ["geometry_incomplete", "geometry_unverified"]) {
  const withPreview = reason === "geometry_unverified";
  test(`旧单展开图 ${reason} 时可转到印刷面并独立下载六面`, async ({ page, syntheticApi }) => {
    const job = completedMockup(id, "旧版展开合成盒");
    job.files = printFaces;
    const previewUrl = `/api/mockups/${id}/files/unfolded_artwork_preview`;
    Object.assign(job, {
      unfolded_print: { status: "failed", reason },
      print_faces_zip: { status: "ready", file_key: "print_faces_zip" },
      ...(withPreview ? { unfolded_artwork_preview_url: previewUrl } : {}),
    });
    syntheticApi.mockups.push(job);
    for (const url of [`/api/mockups/${id}/files/read_front`, previewUrl]) {
      await page.route(`**${url}`, route => route.fulfill({ contentType: "image/svg+xml", body: faceImage }));
    }
    await page.goto(`/mockup/${id}`);
    await page.getByRole("tab", { name: "印刷面", exact: true }).click();
    const read = page.getByRole("region", { name: "印刷面", exact: true });
    await read.getByRole("tab", { name: "2D 展开图" }).click();
    const unfolded = read.getByRole("region", { name: "展开图" });
    await expect(unfolded.getByText(withPreview ? /缺少已确认的粘口和封口信息/ : /刀线无法确认成完整的展开图/)).toBeVisible();
    await expect(unfolded.getByRole("button", { name: /^(重试|生成展开图)$/ })).toHaveCount(0);
    await expect(unfolded.getByRole("link", { name: "下载 PDF" })).toHaveCount(0);
    const preview = unfolded.getByRole("img", { name: "整张稿件预览" });
    if (withPreview) {
      await expect.poll(() => preview.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth > 0)).toBe(true);
    } else {
      await expect(preview).toHaveCount(0);
    }
    await expect(read.getByRole("link", { name: "下载六面" })).toHaveAttribute("href", `/api/mockups/${id}/files/print_faces_zip?download=1`);
    await unfolded.getByRole("button", { name: "查看印刷面" }).click();
    await expect(read.getByRole("img", { name: "正面印刷面" })).toBeVisible();
    expect(syntheticApi.calls.some(call => call.method === "POST" && call.path.endsWith("/unfolded-print"))).toBe(false);
  });
}

test("文件压缩在窄屏和深色主题可使用", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("wb_appearance", JSON.stringify({ theme: "dark", fontPx: 16 })));
  await page.goto("/compress");
  await expect(page.getByRole("heading", { name: "压缩文件" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("选择压缩文件")).toBeEnabled();
  const width = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.width).toBeLessThanOrEqual(width.viewport + 1);
  await page.screenshot({ path: info.outputPath("compression-mobile.png"), fullPage: true });
});
