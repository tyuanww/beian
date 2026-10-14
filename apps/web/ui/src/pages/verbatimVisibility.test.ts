import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const page = readFileSync(new URL("./ReviewPage.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("./ReviewWorkspace.tsx", import.meta.url), "utf8");
const dock = readFileSync(new URL("./ReviewDockPanel.tsx", import.meta.url), "utf8");

describe("verbatim visibility", () => {
  it("keeps all four release conditions in the review page", () => {
    assert.match(page, /REVIEW_COPY\.heldHeader\(heldCount\)/);
    assert.match(workspace, /REVIEW_COPY\.heldCollapse\(held\)/);
    assert.match(dock, /setHeldOpen\(false\); onTab\(key\)/);
    assert.match(dock, /onTab\("issue"\)/);
    assert.match(page, /REVIEW_COPY\.heldBar\(heldCount\)/);
    assert.match(page, /data-testid="review-phone-held"/);
    assert.match(page, /data-testid="review-phone-pending"/);
    assert.match(page, /phonePendingLines\(hits, releaseHeld\)/);
    assert.match(page, /counts\.total > 0 \|\| \(!releaseHeld && heldCount > 0\)/);
    assert.match(page, /data-testid="review-reject-note"/);
    assert.match(dock, /openHeldAfterPending\(pendingRef\.current, counts\.pending, held\.length\)/);
    assert.match(page, /data-testid="review-verbatim-warning"/);
  });
});
