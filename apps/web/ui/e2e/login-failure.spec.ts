import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * 飞书登录失败页：标题只按服务端回跳 URL 的 feishu_error 码定，不看原因文案。
 * 原因来自服务端写的 wb_login_hint cookie，原样显示在标题下。
 */
async function loggedOut(page: Page, hint: string | null) {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ logged_in: false, display_name: null, avatar_url: null, role: null, perms: [] }),
  }));
  if (hint !== null) {
    await page.context().addCookies([{
      name: "wb_login_hint",
      value: encodeURIComponent(hint),
      url: "http://127.0.0.1:5173/",
    }]);
  }
}

test("账号不在账号目录（forbidden）：标题是「进不了这间审稿室」，原因原样显示", async ({ page }) => {
  await loggedOut(page, "这个飞书号不在账号目录。");
  await page.goto("/?feishu_error=forbidden");
  const shell = page.locator(".auth-result");
  await expect(shell.locator(".auth-result-title")).toHaveText("进不了这间审稿室");
  await expect(shell).toContainText("这个飞书号不在账号目录。");
  await expect(shell.getByRole("link", { name: "重新飞书授权" })).toHaveAttribute("href", "/api/auth/feishu/login");
  // 码读完就从地址栏去掉，刷新不会再弹同一张失败页。
  await expect(page).toHaveURL((url) => !url.searchParams.has("feishu_error"));
  if (process.env.LOGIN_FAILURE_SHOT) await page.screenshot({ path: process.env.LOGIN_FAILURE_SHOT, fullPage: true });
});

test("failed 码：标题「暂时登录不了」，原因里有「过期」也不改成「登录已过期」", async ({ page }) => {
  await loggedOut(page, "token 已过期");
  await page.goto("/?feishu_error=failed");
  await expect(page.locator(".auth-result-title")).toHaveText("暂时登录不了");
  await expect(page.locator(".auth-result")).toContainText("token 已过期");
  await expect(page.getByRole("link", { name: "重新飞书授权" })).toBeVisible();
  if (process.env.LOGIN_FAILED_SHOT) await page.screenshot({ path: process.env.LOGIN_FAILED_SHOT, fullPage: true });
});

test("未知码且原因 cookie 已过期：标题兜底「暂时登录不了」，原因兜底仍是「飞书授权未完成。」", async ({ page }) => {
  await loggedOut(page, null);
  await page.goto("/?feishu_error=teapot");
  await expect(page.locator(".auth-result-title")).toHaveText("暂时登录不了");
  await expect(page.locator(".auth-result")).toContainText("飞书授权未完成。");
});
