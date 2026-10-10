import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAV_LABEL, REVIEW_STATUS_LABEL, WAIT_TITLE, reviewCompletedLabel } from "./labels.js";
import { statusLabel } from "../pages/TasksPage.js";
import { statusLead } from "../pages/reviewStatus.js";
import { historyTaskRow } from "../pages/historyRows.js";

const done = (complete_kind?: string) => ({
  id: "t1",
  title: "花盒",
  type: "pack",
  status: "completed",
  ...(complete_kind === undefined ? {} : { complete_kind }),
});

describe("reviewCompletedLabel", () => {
  it("splits the completed review by complete_kind", () => {
    assert.equal(reviewCompletedLabel("signed"), "已通过");
    assert.equal(reviewCompletedLabel("rework"), "已退回");
  });

  it("keeps 已提交 for legacy records without complete_kind or with an unknown value", () => {
    assert.equal(reviewCompletedLabel(undefined), "已提交");
    assert.equal(reviewCompletedLabel(null), "已提交");
    assert.equal(reviewCompletedLabel(""), "已提交");
    assert.equal(reviewCompletedLabel("approved"), "已提交");
    assert.equal(REVIEW_STATUS_LABEL.completed, "已提交");
  });
});

describe("completed review labels on every surface", () => {
  for (const [kind, text] of [["signed", "已通过"], ["rework", "已退回"], [undefined, "已提交"], ["weird", "已提交"]] as const) {
    it(`complete_kind=${String(kind)} → ${text}`, () => {
      assert.equal(statusLabel(done(kind)).text, text);
      assert.equal(historyTaskRow(done(kind)).status, text);
      assert.match(statusLead({ ...done(kind), pages: [{ url: "/p.png", page: 1 }] }, 0, [{ url: "/p.png", page: 1 }]), new RegExp(`${text}$`));
    });
  }

  it("does not use complete_kind for a task that is not completed", () => {
    assert.equal(statusLabel({ ...done("signed"), status: "in_review" }).text, REVIEW_STATUS_LABEL.pending);
  });
});

describe("WAIT_TITLE", () => {
  it("stays 3 characters because the wait loader splits it per character", () => {
    for (const title of Object.values(WAIT_TITLE)) assert.equal(Array.from(title).length, 3);
  });
});

describe("NAV_LABEL", () => {
  it("has a label for every menu key", () => {
    assert.deepEqual(Object.keys(NAV_LABEL), ["review", "mockup", "compression", "history", "settings"]);
  });
});
