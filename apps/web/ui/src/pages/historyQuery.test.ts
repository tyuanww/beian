import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyHistoryFilters, historyQuery, historyStatusColor, historyTimeFilters } from "./historyQuery.js";
import { hrefOf, parsePath, isSpaPath } from "../appRoute.js";
import { displayBytes, validateCompressionFiles } from "./CompressionPage.js";
it("sends timezone-aware date bounds and omits an empty cursor", () => {
  const query = new URLSearchParams(historyQuery({ ...emptyHistoryFilters, q: " 海葡萄 ", date_from: "2026-10-01", date_to: "2026-10-09" }, "", -480));
  assert.equal(query.get("tz"), "+08:00");
  assert.equal(query.get("q"), "海葡萄");
  assert.equal(query.get("limit"), "10");
  assert.equal(query.has("cursor"), false);
  assert.equal(new URLSearchParams(historyQuery(emptyHistoryFilters, "after+item")).get("cursor"), "after+item");
});
it("uses seven inclusive local calendar days across a year boundary without sending the preset", () => {
  const range = historyTimeFilters("recent", new Date(2026, 0, 3, 0, 30));
  assert.deepEqual(range, { time_mode: "recent", date_from: "2025-12-28", date_to: "2026-01-03" });
  const query = new URLSearchParams(historyQuery({ ...emptyHistoryFilters, ...range, type: "compression", status: "unmet_target" }, "", -480));
  assert.equal(query.has("time_mode"), false);
  assert.equal(query.get("date_from"), "2025-12-28");
  assert.equal(query.get("date_to"), "2026-01-03");
  assert.equal(query.get("status"), "unmet_target");
  const all = new URLSearchParams(historyQuery({ ...emptyHistoryFilters, ...historyTimeFilters("all") }));
  assert.equal(all.has("date_from"), false);
  assert.equal(all.has("date_to"), false);
  assert.equal(all.has("tz"), false);
});
it("distinguishes failures from processing and partial results", () => {
  assert.equal(historyStatusColor("failed"), "error");
  assert.equal(historyStatusColor("compare_failed"), "error");
  assert.equal(historyStatusColor("comparing"), "processing");
  assert.equal(historyStatusColor("partial"), "warning");
  assert.equal(historyStatusColor("unmet_target"), "warning");
});
it("restores compression detail and receipt routes without changing review routes", () => {
  const route = parsePath("/compress/abcdef123456");
  assert.equal(route.view, "compression");
  assert.equal(hrefOf(route), "/compress/abcdef123456");
  assert.equal(isSpaPath("/compress/abcdef123456"), true);
  assert.equal(hrefOf(parsePath("/compress", "?receipt=abcdef123456")), "/compress?receipt=abcdef123456");
});
it("does not invent output sizes and rejects oversized or unsupported batches", () => {
  assert.equal(displayBytes(null), "—");
  assert.equal(validateCompressionFiles([new File(["pdf"], "seal.pdf")]), null);
  assert.ok(validateCompressionFiles([new File(["html"], "unsafe.html")]));
  assert.ok(validateCompressionFiles(Array.from({ length: 21 }, () => new File(["x"], "x.pdf"))));
});
