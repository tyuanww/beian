import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HIT_DECISIONS, VERBATIM_STATUSES, hitNeedsDecision, newCompareVerbatimFlag } from "./tasks.js";

describe("verbatim contract", () => {
  it("does not flag a new compare task unless the model dir is complete", () => {
    assert.deepEqual(newCompareVerbatimFlag(""), {});
    assert.deepEqual(newCompareVerbatimFlag("/tmp/verbatim-missing-model-dir"), {});
    const dir = mkdtempSync(join(tmpdir(), "verbatim-flag-"));
    writeFileSync(join(dir, "NOTICE"), "notice\n");
    assert.deepEqual(newCompareVerbatimFlag(dir), {});
    for (const name of ["PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_medium.onnx", "PP-OCRv6_rec_small.onnx"]) {
      writeFileSync(join(dir, name), "x");
    }
    assert.deepEqual(newCompareVerbatimFlag(dir), { verbatim_check: true });
  });

  it("locks the whitelist to the shared status file", () => {
    const file = JSON.parse(readFileSync(new URL("../../backend/app/verbatim_statuses.json", import.meta.url), "utf8")) as { statuses: string[] };
    assert.deepEqual(VERBATIM_STATUSES.statuses, file.statuses);
    for (const status of file.statuses) {
      assert.equal(hitNeedsDecision({ status, decision: "pending" }) || status === "待人工确认", true);
    }
    assert.equal(hitNeedsDecision({ status: "待人工确认", decision: "pending" }), false);
    assert.equal(hitNeedsDecision({ status: "漏字", decision: "pending" }), true);
    assert.equal(HIT_DECISIONS.includes("ignore"), true);
  });
});
