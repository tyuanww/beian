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
});
