import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

// Value: protects=dev favicon proxy targets the product server; fails_when=the /favicon.ico proxy entry is removed; why_new=no other test reads vite.config; seam=none; no_claim=does not start Vite
it("dev proxy forwards favicon to the product server", () => {
  const src = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(src, /"\/favicon\.ico": \{ target: "http:\/\/127\.0\.0\.1:8787", changeOrigin: true \}/);
});
