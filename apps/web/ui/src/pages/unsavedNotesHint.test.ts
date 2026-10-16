import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { unsavedNotesHint } from "./unsavedNotesHint.js";
import { REVIEW_COPY } from "../copy/labels.js";

describe("unsavedNotesHint", () => {
  it("shows the product reason next to greyed sign/reject", () => {
    assert.equal(unsavedNotesHint(true), REVIEW_COPY.unsavedNotesBlock);
    assert.equal(unsavedNotesHint(false), null);
  });

  it("phone save-notes uses the secondary Ant Button, not btn-ghost", () => {
    const page = readFileSync(new URL("./ReviewPage.tsx", import.meta.url), "utf8");
    assert.match(page, /className="review-draft-settle"/u);
    assert.doesNotMatch(page, /btn-ghost review-draft-settle|review-draft-settle[^>]*(btn-ghost)/u);
    assert.match(page, /<Button[^>]*className="review-draft-settle"/u);
    assert.match(page, /unsavedNotesHint\(hasUnsavedNotes\)/u);
  });
});
