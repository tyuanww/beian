import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("release version and review documentation", () => {
  it("keeps release versions aligned and preserves the paragraph card documentation", () => {
    const root = resolve(here, "../../../..");
    const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
    const version = read("VERSION").trim();
    const changelog = read("CHANGELOG.md");
    const index = read("apps/web/server/src/index.ts");
    const pkg = JSON.parse(read("package.json")) as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(changelog.match(/^# Changelog\n\n## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}\n/)?.[1], version);
    assert.equal(index.match(/^const VERSION = "([^"]+)";$/m)?.[1], version);
    assert.equal(pkg.version, version.split(".").slice(0, 3).join("."));
    assert.match(changelog, /^## \[0\.31\.1\.28\] - 2026-10-19$/m);
    assert.match(read("docs/contracts/review.md"), /宽 440px/);
    assert.match(read("docs/contracts/interface.md"), /关掉「对照」时只画当前字段/);
    assert.match(read("docs/explanation-review-spot.md"), /贴在当前框旁边/);
    assert.match(read("docs/howto-review-spot.md"), /怎么使用对照/);
    assert.match(read("TODOS.md"), /这一版不勾 B01\.4/);
  });
});
