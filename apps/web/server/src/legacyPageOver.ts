/** 旧失败单不会自己归零：归档与否由老板定，否则长期保留。对生产 tasks 目录跑统计须老板单独批准。 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobErrorCode, Task } from "./tasks.js";

const LEGACY_PAGE_OVER_TEXTS = new Set(["稿件超过 1 页，暂不支持核对，请联系管理员", "这一单页数超过可核对页数"]);

export function legacyPageOverCode(t: Task): JobErrorCode | undefined {
  if (t.job_error_code) return undefined;
  if (t.job_status !== "failed" && t.status !== "compare_failed") return undefined;
  const text = (typeof t.job_error === "string" ? t.job_error : "").trim();
  return LEGACY_PAGE_OVER_TEXTS.has(text) ? "page_over" : undefined;
}

export function countLegacyPageOverTasks(dir: string): { total: number; ids: string[] } {
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, name), "utf8")) as Task;
      if (legacyPageOverCode(t)) ids.push(String(t.id || name.slice(0, -5)));
    } catch {
      continue;
    }
  }
  return { total: ids.length, ids };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("用法：npm run legacy:page-over -- <tasks 目录>");
    process.exit(2);
  }
  const { total, ids } = countLegacyPageOverTasks(dir);
  console.log(JSON.stringify({ legacy_page_over: total, ids }));
}
