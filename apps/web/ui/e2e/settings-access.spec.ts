import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** 老板 2026-10-11 批准：「设置」只给管理员；非管理员直达 /settings 只见无权限，且不请求 /api/settings。 */
async function asRole(page: Page, role: "admin" | "reviewer" | "viewer") {
  const settingsCalls: string[] = [];
  await page.route("**/api/auth/me", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      logged_in: true,
      display_name: "E2E（合成用户）",
      avatar_url: null,
      open_id: "ou_e2e_synthetic",
      role,
      perms: ["read", "create"],
    }),
  }));
  await page.route("**/api/settings**", (route) => {
    settingsCalls.push(new URL(route.request().url()).pathname);
    // 模拟后端按角色裁剪后的形状：一个空分组 + 一个缺 fields 的分组 + 一个正常分组。
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        groups: [
          { title: "密钥", fields: [] },
          { title: "残缺分组" },
          { title: "飞书推送", fields: [{ key: "LARK_NOTIFY", label: "推送接收人", kind: "text", help: "", restart: false, set: true, last4: "", value: "ou_x" }] },
        ],
      }),
    });
  });
  return settingsCalls;
}

for (const role of ["reviewer", "viewer"] as const) {
  test(`${role} 侧栏没有设置，直达 /settings 显示无权限且不请求 /api/settings`, async ({ page }) => {
    const calls = await asRole(page, role);
    await page.goto("/reviewup");
    const nav = page.locator(".side-nav");
    await expect(nav.getByText("审稿台", { exact: true })).toBeVisible();
    await expect(nav.getByText("设置", { exact: true })).toHaveCount(0);

    await page.goto("/settings");
    const denied = page.locator(".settings-denied");
    await expect(denied).toContainText("这里只有管理员能看");
    await expect(denied).not.toContainText("403");
    await expect(denied).not.toContainText("无权限");
    await expect(page.locator(".settings-page")).toHaveCount(0);
    expect(calls).toEqual([]);

    await page.locator(".account-row").click();
    await page.getByRole("menuitem", { name: "外观" }).click();
    await expect(page.getByRole("dialog", { name: "外观" })).toBeVisible();
    const font = page.getByLabel("字号像素");
    await expect(font).toBeVisible();
    await font.fill("20");
    await font.blur();
    // 不用保存，立刻作用到页面，只写本机 localStorage。
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-font"))).toBe("20px");
    expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("wb_appearance")))).toBe(true);
    expect(calls).toEqual([]);

    await page.keyboard.press("Escape");
    await page.locator(".settings-denied").getByRole("button", { name: "回审稿台" }).click();
    await expect(page).toHaveURL(/\/reviewup$/);
  });
}

test("admin 侧栏仍有设置，裁剪后的空分组不进菜单", async ({ page }) => {
  const calls = await asRole(page, "admin");
  await page.goto("/reviewup");
  await expect(page.locator(".side-nav").getByText("设置", { exact: true })).toBeVisible();
  await page.locator(".account-row").click();
  await expect(page.getByRole("menuitem", { name: "外观" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "退出" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".side-nav").getByText("设置", { exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".settings-denied")).toHaveCount(0);
  const aside = page.locator(".settings-aside");
  await expect(aside.getByText("外观")).toBeVisible();
  await expect(aside.getByRole("menuitem")).not.toContainText(["密钥"]);
  await expect(aside.getByText("残缺分组")).toHaveCount(0);
  expect(calls).toContain("/api/settings");
});

for (const theme of ["light", "dark"] as const) {
  test(`外观弹窗在${theme}主题下是实心面并有遮罩`, async ({ page }) => {
    await asRole(page, "reviewer");
    await page.addInitScript((t) => { localStorage.setItem("wb_appearance", JSON.stringify({ theme: t })); localStorage.setItem("wb_appearance:ou_e2e_synthetic", JSON.stringify({ theme: t })); }, theme);
    await page.goto("/reviewup");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.locator(".account-row").click();
    await page.getByRole("menuitem", { name: "外观" }).click();
    const dialog = page.getByRole("dialog", { name: "外观" });
    await expect(dialog).toBeVisible();
    const box = page.locator(".appearance-modal .ant-modal-container, .appearance-modal .ant-modal-content").first();
    const bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    const surface = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface").trim());
    expect(bg).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)/);
    expect(bg).toBe(await page.evaluate((c) => { const d = document.createElement("div"); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, surface));
    const mask = page.locator(".appearance-modal .ant-modal-mask");
    await expect(mask).toBeVisible();
    // 遮罩取 --mask token（经浏览器规范化后比较）。
    const maskToken = await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.backgroundColor = "var(--mask)";
      document.body.append(d);
      const v = getComputedStyle(d).backgroundColor;
      d.remove();
      return v;
    });
    expect(maskToken).not.toBe("rgba(0, 0, 0, 0)");
    expect(await mask.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(maskToken);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
}
