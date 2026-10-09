import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyHistoryFilters, historyQuery } from "./historyQuery.js";
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
