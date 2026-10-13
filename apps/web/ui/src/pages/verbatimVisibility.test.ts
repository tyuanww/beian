import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const page = readFileSync(new URL("./ReviewPage.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("./ReviewWorkspace.tsx", import.meta.url), "utf8");
const dock = readFileSync(new URL("./ReviewDockPanel.tsx", import.meta.url), "utf8");

describe("verbatim visibility", () => {
  it("keeps all four release conditions in the review page", () => {
    assert.match(page, /data-testid="review-held-line"/);
    assert.match(workspace, /REVIEW_COPY\.heldButton\(held\)/);
    assert.match(dock, /data-testid="review-held-bar"/);
    assert.match(page, /data-testid="review-phone-held"/);
    assert.match(page, /data-testid="review-verbatim-warning"/);
  });
});
