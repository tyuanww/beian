import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("paragraph card version pin", () => {
  it("pins runtime 0.31.1.25 and leaves the npm version at 0.31.1", () => {
    const version = readFileSync(resolve(here, "../../../../VERSION"), "utf8").trim();
    const changelog = readFileSync(resolve(here, "../../../../CHANGELOG.md"), "utf8");
    const index = readFileSync(resolve(here, "../../server/src/index.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve(here, "../../../../package.json"), "utf8")) as { version: string };
    assert.equal(version, "0.31.1.25");
    assert.match(changelog, /^# Changelog\n\n## \[0\.31\.1\.25\] - 2026-10-15\n/);
    assert.match(index, /const VERSION = "0\.31\.1\.25";/);
    assert.equal(pkg.version, "0.31.1");
  });
});
