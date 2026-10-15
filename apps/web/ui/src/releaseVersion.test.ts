import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("paragraph card version pin", () => {
  it("pins runtime 0.31.1.26 and leaves the npm version at 0.31.1", () => {
    const root = resolve(here, "../../../..");
    const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
    const version = read("VERSION").trim();
    const changelog = read("CHANGELOG.md");
    const index = read("apps/web/server/src/index.ts");
    const pkg = JSON.parse(read("package.json")) as { version: string };
    assert.equal(version, "0.31.1.26");
    assert.match(changelog, /^# Changelog\n\n## \[0\.31\.1\.26\] - 2026-10-15\n/);
    assert.match(index, /const VERSION = "0\.31\.1\.26";/);
    assert.equal(pkg.version, "0.31.1");
    assert.match(read("docs/contracts/review.md"), /宽 440px/);
    assert.match(read("docs/contracts/interface.md"), /就地对照/);
    assert.match(read("docs/explanation-review-spot.md"), /贴到当前框旁边/);
    assert.match(read("docs/howto-review-spot.md"), /怎么使用就地对照/);
    assert.match(read("TODOS.md"), /这一版不勾 B01\.4/);
  });
});
