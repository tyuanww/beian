import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-render-actor-");

const { renderTriggerActorLabel } = await import("./jobs.js");

const base = {
  client_request_id: "r", payload_sha256: "0".repeat(64), mutation_id: "m0123456789abcdef", mode: "legacy_relight" as const,
  source_generation_id: "g0", expected_current_generation_id: "g0", started_current_generation_id: null,
  created_at: "2026-10-16T00:00:00Z", actor_id: "ou_trigger01",
};

describe("renderTriggerActorLabel", () => {
  it("writes the trigger's display name", () => {
    assert.equal(renderTriggerActorLabel({ ...base, actor_name: "触发人丁" }), "触发人丁");
  });
  it("missing name → null (old queued requests, no request at all)", () => {
    assert.equal(renderTriggerActorLabel({ ...base }), null);
    assert.equal(renderTriggerActorLabel({ ...base, actor_name: "  " }), null);
    assert.equal(renderTriggerActorLabel(undefined), null);
  });
  it("never an account id", () => {
    assert.equal(renderTriggerActorLabel({ ...base, actor_name: "ou_trigger01" }), null);
    assert.equal(renderTriggerActorLabel({ ...base, actor_name: "ou_7d8a6e6df7621556ce0d21922b676706" }), null);
  });
});
