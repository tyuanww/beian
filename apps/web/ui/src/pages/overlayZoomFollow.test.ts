import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const page = readFileSync(new URL("./ReviewPage.tsx", import.meta.url), "utf8");
const workspaceCss = readFileSync(new URL("../styles/reviewWorkspace.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

describe("overlay zoom follow", () => {
  it("fits the paragraph only when the spot arms, and pans when the scale changes", () => {
    const fit = page.match(/if \(layout !== "overlay" \|\| !panelOpen \|\| !spotOn\) return;\s*fitHitRef\.current\(activeRef\.current\);\s*\}, \[([^\]]+)\]\)/);
    assert.ok(fit, "fit effect missing");
    assert.doesNotMatch(fit[1], /zoom\.scale/);
    const pan = page.match(/panToClearPanel\([\s\S]*?\}, \[([^\]]+)\]\)/);
    assert.ok(pan, "pan effect missing");
    assert.match(pan[1], /zoom\.scale/);
  });

  it("sizes the phone clearance from the action bar, and keeps manuscript hits on the visible box", () => {
    assert.match(page, /--review-phone-actions/);
    assert.match(workspaceCss, /var\(--review-phone-actions, 76px\) \+ 52px/);
    assert.doesNotMatch(workspaceCss, /216px/);
    assert.doesNotMatch(workspaceCss, /hit-range::before/);
    assert.doesNotMatch(appCss, /\.pin::before/);
    assert.match(workspaceCss, /button\.pin \{ min-width: 0; min-height: 0; \}/);
  });
});
