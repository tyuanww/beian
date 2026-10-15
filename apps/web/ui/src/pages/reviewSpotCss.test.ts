import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("spot frame paint", () => {
  it("keeps the hit wash and paints the paragraph frame clear", () => {
    const app = readFileSync(resolve(here, "../styles/app.css"), "utf8");
    const workspace = readFileSync(resolve(here, "../styles/reviewWorkspace.css"), "utf8");
    assert.match(app, /\.hit-box \{[^}]*color-mix\(in srgb, var\(--pin\) 16%, transparent\)/s);
    assert.match(workspace, /\.review-workspace \.hit-box\.hit-range \{[^}]*background:\s*transparent/s);
    assert.match(workspace, /\.review-spot-card \{[^}]*z-index:\s*7/s);
    assert.match(workspace, /\.review-sidebar\.is-overlay \{[^}]*z-index:\s*6/s);
    assert.match(workspace, /\.review-panel-tab \{[^}]*z-index:\s*8/s);
  });

  it("lets the current frame take clicks and darkens the difference mark", () => {
    const workspace = readFileSync(resolve(here, "../styles/reviewWorkspace.css"), "utf8");
    assert.match(workspace, /\.review-workspace \.hit-box\[data-spot-frame\] \{[^}]*pointer-events:\s*auto/s);
    assert.match(workspace, /\.review-workspace \.hit-box\.hit-underline \{[^}]*box-shadow:\s*0 max\(0\.5px, calc\(2px \/ var\(--spot-zoom, 1\)\)\) 0 0 var\(--pin\)/s);
    assert.match(workspace, /\.review-workspace \.hit-box\.hit-range \{[^}]*outline:/s);
    assert.match(workspace, /\.review-spot-mark \{[^}]*color-mix\(in srgb, var\(--pin\) 72%, transparent\)/s);
    assert.match(workspace, /html\[data-theme="dark"\] \.review-spot-mark \{[^}]*color-mix\(in srgb, var\(--pin\) 46%, transparent\)/s);
  });
});
