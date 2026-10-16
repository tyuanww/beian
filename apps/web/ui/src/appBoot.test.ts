import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { bootOnce } from "./appBoot.js";

describe("bootOnce", () => {
  it("runs the boot request once even if the effect re-runs", () => {
    const flag = { current: false };
    let calls = 0;
    bootOnce(flag, () => { calls++; });
    bootOnce(flag, () => { calls++; });
    assert.equal(calls, 1);
  });

  it("App boot effect lists refreshMe as a dependency without an eslint-disable", () => {
    const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(src, /eslint-disable[^\n]*exhaustive-deps/u);
    assert.match(src, /bootOnce\(bootedRef, \(\) => \{ void refreshMe\(\); \}\);\n  \}, \[refreshMe\]\);/u);
  });
});
