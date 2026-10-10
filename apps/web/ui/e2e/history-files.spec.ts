import { expect, test } from "./fixtures";
test.use({ timezoneId: "Asia/Shanghai" });

const P = "cc99285d_pack";
const names = [
  `${P}.glb`, `${P}_3D包装展示.pptx`,
  `${P}_front_right.png`, `${P}_back_left.png`, `${P}_front_right_ground.png`, `${P}_back_left_ground.png`,
  `${P}_front_right_white.png`, `${P}_back_left_white.png`, `${P}_front_right_ground_white.png`, `${P}_back_left_ground_white.png`,
  `${P}_front_right_card.png`, `${P}_back_left_card.png`, `${P}_front_right_ground_card.png`, `${P}_back_left_ground_card.png`,
  "cc99285d_white_sheet.pdf", "转曲 D 达肤妍原B5.ai", `${P}_set.png`,
];
const row = (matched: string[]) => ({ id: "cc99285d0000", type: "mockup", title: "转曲 D 达肤妍原B5 26J08A", product_name: "", status: "done",
  created_at: "2026-10-01T00:00:00.000Z", creator_id: "ou_e2e_synthetic", creator_name: "合成用户", names, matched_names: matched, visibility: "team" });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/history?*", async route => {
    const q = (new URL(route.request().url()).searchParams.get("q") || "").toLowerCase();
    const matched = q ? names.filter(name => name.toLowerCase().includes(q)) : [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [row(matched)], total: 1, next_cursor: null,
      facets: { type: { review: 0, mockup: 1, compression: 0, upload: 0 }, status: { done: 1 } } }) });
  });
});

test("历史打样记录显示一行文件摘要，行内展开分组清单且不打开记录", async ({ page }) => {
  await page.goto("/history");
  const record = page.getByRole("row").filter({ hasText: "转曲 D 达肤妍原B5 26J08A" });
  await expect(record.locator(".history-files-summary")).toHaveText("3D 模型 · 展示 PPT · 效果图 5 · 白底图 4 · 卡片图 4 · 平面图 PDF · 源稿");
  await expect(record.getByText(`${P}_set.png`)).toHaveCount(0);
  const toggle = record.getByRole("button", { name: "展开 17 个文件" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page).toHaveURL("/history");
  await expect(record.getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");
  await expect(record.locator(".history-files-group-label").first()).toHaveText("3D 模型（1）");
  await expect(record.getByText(`${P}_set.png`)).toBeVisible();
  await record.getByText("cc99285d_white_sheet.pdf").click();
  await expect(page).toHaveURL("/history");
  await record.getByRole("button", { name: "收起" }).click();
  await expect(record.getByText(`${P}_set.png`)).toHaveCount(0);
});

test("搜索文件名时默认展开、命中排前并高亮，其余文件仍可见", async ({ page }) => {
  await page.goto("/history");
  await page.getByRole("searchbox", { name: "搜索历史" }).fill("back_left");
  await page.getByRole("searchbox", { name: "搜索历史" }).press("Enter");
  const record = page.getByRole("row").filter({ hasText: "转曲 D 达肤妍原B5 26J08A" });
  await expect(record.getByText("· 匹配 6 个")).toBeVisible();
  await expect(record.getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");
  const effect = record.locator(".history-files-group").filter({ hasText: "效果图（5）" }).locator("li");
  await expect(effect.first()).toHaveClass(/is-hit/);
  await expect(effect.first().locator("mark")).toHaveText("back_left");
  await expect(record.getByText(`${P}_set.png`)).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索历史" }).fill("");
  await expect(record.getByRole("button", { name: "展开 17 个文件" })).toBeVisible();
});
