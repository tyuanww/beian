/**
 * 仅测试注入点（*ForTest）生产代码调不到的证据：
 * 1) 非 VITEST 进程里每个 *ForTest 调用都抛错，开关与删除/fsync/缓存都不变；
 * 2) 生产源码（非 *.test.ts）里没有任何地方引用这些注入点；
 * 3) glbWebpVariant.ts 里每个导出的 *ForTest 第一行就是 assertTestRuntime，且这是它唯一读环境变量的地方。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-variant-hooks-");

const variant = await import("./glbWebpVariant.js");
const SRC = dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = readFileSync(join(SRC, "glbWebpVariant.ts"), "utf8");
const HOOKS = [...MODULE_SRC.matchAll(/export function (\w+ForTest)\(/g)].map((m) => m[1]);

describe("glb webp variant *ForTest hooks are test-only", () => {
  it("module exports exactly the known hooks", () => {
    assert.deepEqual(HOOKS.sort(), [
      "glbWebpVariantHashComputeCountForTest",
      "resetGlbWebpVariantCacheForTest",
      "setGlbWebpVariantDirSyncForTest",
      "setGlbWebpVariantEnabledForTest",
      "setGlbWebpVariantRenameForTest",
      "setGlbWebpVariantUnlinkForTest",
    ]);
  });

  it("every hook throws outside VITEST and changes nothing", () => {
    const calls: Record<string, () => unknown> = {
      setGlbWebpVariantEnabledForTest: () => variant.setGlbWebpVariantEnabledForTest(true),
      setGlbWebpVariantRenameForTest: () => variant.setGlbWebpVariantRenameForTest(() => undefined),
      setGlbWebpVariantUnlinkForTest: () => variant.setGlbWebpVariantUnlinkForTest(() => undefined),
      setGlbWebpVariantDirSyncForTest: () => variant.setGlbWebpVariantDirSyncForTest({ fsync: () => undefined }),
      resetGlbWebpVariantCacheForTest: () => variant.resetGlbWebpVariantCacheForTest(),
      glbWebpVariantHashComputeCountForTest: () => variant.glbWebpVariantHashComputeCountForTest(),
    };
    assert.deepEqual(Object.keys(calls).sort(), [...HOOKS].sort());
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      for (const [name, call] of Object.entries(calls)) {
        assert.throws(call, new RegExp(`${name} 只能在 VITEST 使用`), name);
      }
      assert.equal(variant.glbWebpVariantEnabled(), false, "a production call cannot turn the variant on");
    } finally {
      process.env.VITEST = saved;
    }
  });

  it("each exported hook starts with assertTestRuntime; the guard is the module's only env read", () => {
    for (const name of HOOKS) {
      assert.match(MODULE_SRC, new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{\\n  assertTestRuntime\\("${name}"\\);`), name);
    }
    const envReads = MODULE_SRC.match(/process\.env\.\w+/g) || [];
    assert.deepEqual([...new Set(envReads)], ["process.env.VITEST"]);
    assert.doesNotMatch(readFileSync(join(SRC, "rolloutFlags.ts"), "utf8"), /process\.env/);
  });

  it("no production source references any hook", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SRC)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "glbWebpVariant.ts") continue;
      const text = readFileSync(join(SRC, name), "utf8");
      for (const hook of HOOKS) if (text.includes(hook)) offenders.push(`${name}:${hook}`);
    }
    assert.deepEqual(offenders, []);
  });
});
