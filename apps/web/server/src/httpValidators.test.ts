import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ifNoneMatchSatisfied } from "./httpValidators.js";

describe("ifNoneMatchSatisfied", () => {
  // Value: protects=weak If-None-Match matches W/ prefix and *; fails_when=stripWeak or star handling removed; why_new=304 routes share helper only; seam=none; no_claim=none beyond protects
  it("matches a weak tag, a list, and star", () => {
    const etag = `"sha256-abc"`;
    assert.equal(ifNoneMatchSatisfied(etag, etag), true);
    assert.equal(ifNoneMatchSatisfied(`W/${etag}`, etag), true);
    assert.equal(ifNoneMatchSatisfied(`W/"other", ${etag}`, etag), true);
    assert.equal(ifNoneMatchSatisfied("*", etag), true);
    assert.equal(ifNoneMatchSatisfied(`W/"other"`, etag), false);
    assert.equal(ifNoneMatchSatisfied(undefined, etag), false);
  });
});
