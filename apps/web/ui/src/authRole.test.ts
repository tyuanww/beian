import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAdmin } from "./authRole.js";

describe("isAdmin", () => {
  it("only exact admin role", () => {
    assert.equal(isAdmin({ role: "admin" }), true);
    for (const role of ["reviewer", "viewer", "Admin", "", null]) assert.equal(isAdmin({ role }), false);
    assert.equal(isAdmin(null), false);
    assert.equal(isAdmin(undefined), false);
  });
});
