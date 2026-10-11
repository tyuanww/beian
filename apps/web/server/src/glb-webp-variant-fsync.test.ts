import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-variant-fsync-");

const variant = await import("./glbWebpVariant.js");

const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

function plant(jobId: string): string {
  const dir = variant.glbWebpVariantDir(jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "box.glb.webpv"), "v");
  writeFileSync(join(dir, "box.glb.webpv.json"), "{}");
  return dir;
}

function captureDebug(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.debug;
  console.debug = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.debug = original; } };
}

afterEach(() => variant.setGlbWebpVariantDirSyncForTest(null));

describe("fsyncDir best-effort branch (Windows directories)", () => {
  for (const code of ["EISDIR", "EPERM"]) {
    it(`open(dir) failing with ${code} does not throw and logs one debug line`, () => {
      const debug = captureDebug();
      let closes = 0;
      try {
        variant.setGlbWebpVariantDirSyncForTest({ open: () => { throw errno(code); }, close: () => { closes += 1; } });
        const dir = makeTestTempDir("beian-fsync-open-");
        assert.doesNotThrow(() => variant.fsyncDir(dir));
        assert.doesNotThrow(() => variant.fsyncDir(dir));
      } finally {
        debug.restore();
      }
      assert.equal(closes, 0, "nothing opened, nothing to close");
      assert.equal(debug.lines.length, 1, "only the first failure is logged");
      assert.match(debug.lines[0], new RegExp(code));
    });

    it(`fsync(fd) failing with ${code} does not throw and still closes the directory fd`, () => {
      const debug = captureDebug();
      const closed: number[] = [];
      try {
        variant.setGlbWebpVariantDirSyncForTest({ open: () => 4242, fsync: () => { throw errno(code); }, close: (fd) => { closed.push(fd); } });
        assert.doesNotThrow(() => variant.fsyncDir("/any/dir"));
      } finally {
        debug.restore();
      }
      assert.deepEqual(closed, [4242]);
      assert.equal(debug.lines.length, 1);
    });
  }

  it("close failing after a successful fsync is swallowed", () => {
    variant.setGlbWebpVariantDirSyncForTest({ open: () => 7, fsync: () => undefined, close: () => { throw errno("EBADF"); } });
    assert.doesNotThrow(() => variant.fsyncDir("/any/dir"));
  });

  it("drop and boot cleanup still complete when every directory fsync fails", () => {
    const debug = captureDebug();
    try {
      variant.setGlbWebpVariantDirSyncForTest({ open: () => { throw errno("EPERM"); } });
      const dropped = plant("ab12ab12ab01");
      variant.dropGlbWebpVariant("ab12ab12ab01");
      assert.deepEqual(readdirSync(dropped), []);
      const orphan = plant("ab12ab12ab02");
      assert.equal(variant.cleanupGlbWebpVariantsOnBoot(), 2, "orphan meta (source gone) + its variant");
      assert.deepEqual(readdirSync(orphan), []);
    } finally {
      debug.restore();
    }
  });

  it("the real platform fsyncDir never throws (Windows: EISDIR/EPERM path; POSIX: real fsync)", () => {
    const debug = captureDebug();
    try {
      assert.doesNotThrow(() => variant.fsyncDir(makeTestTempDir("beian-fsync-real-")));
      assert.doesNotThrow(() => variant.fsyncDir(join(makeTestTempDir("beian-fsync-missing-"), "nope")));
    } finally {
      debug.restore();
    }
  });
});
