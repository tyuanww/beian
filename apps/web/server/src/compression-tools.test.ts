import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { compressionPolicyFingerprint, compressionPolicySnapshot, compressionFileReady, compressionToolsForMedia } from "./compressionPolicy.js";
import { QPDF_REQUIRED_VERSION, qpdfVersionMatches, toolGenerationOf, budgetFromProbe } from "./compressionProbe.js";
import { setCompressionExecutorForTest, executeCompressionFile } from "./compressionExecute.js";
import { qpdfLosslessArgs } from "./compressionModel.js";
import {
  assertCompressionArgv,
  containArgs,
  imageWorkerCommand,
  javaHelperCommand,
} from "./compressionTools.js";
import { makeTestTempDir } from "./testTemp.js";

const worker = fileURLToPath(new URL("../tools/compression/image-worker.mjs", import.meta.url));
const javaSource = fileURLToPath(new URL("../tools/compression/PdfCompress.java", import.meta.url));

function runWorker(input: string, output: string, media: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, "--input", input, "--output", output, "--media", media], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout }));
  });
}

describe("compression tools", () => {
  it("does not import sharp into the Hono sources", () => {
    const sourceDir = fileURLToPath(new URL(".", import.meta.url));
    for (const name of readdirSync(sourceDir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(sourceDir, name), "utf8");
      assert.equal(/from ["']sharp["']/.test(text), false, name);
    }
  });

  it("pins helper commands and fingerprints qpdf version changes", () => {
    const lossless = qpdfLosslessArgs("in.pdf", "out.pdf");
    assert.equal(lossless.some((arg) => /no-warn|warning-exit-0|optimize-images/.test(arg)), false);
    const image = imageWorkerCommand("in.jpg", "out.jpg", "image/jpeg");
    assert.equal(image[0], process.execPath);
    assert.equal(image.includes("--media"), true);
    const java = javaHelperCommand("/usr/bin/java", "/opt/pdfbox.jar", "recompress", ["in.pdf", "out.pdf", "60"]);
    assert.equal(java.includes("-Xmx256m"), true);
    assert.equal(java.includes("--source"), true);
    assert.equal(java.includes("17"), true);
    assertCompressionArgv(containArgs(image));
    assert.throws(() => assertCompressionArgv(["qpdf", "--no-warn"]));
    assert.throws(() => assertCompressionArgv(["qpdf", "--warning-exit-0"]));
    assert.throws(() => assertCompressionArgv(["qpdf", "--optimize-images"]));
    const left = toolGenerationOf({ mechanism: "rlimit:as", sharp: "0.34.4", qpdf: "11.9", java: null, pdfbox: null });
    const right = toolGenerationOf({ mechanism: "rlimit:as", sharp: "9.9.9", qpdf: "12.2.0", java: null, pdfbox: null });
    assert.notEqual(left, right);
    assert.notEqual(left, toolGenerationOf({ mechanism: "rlimit:as", sharp: "0.34.4", qpdf: null, java: null, pdfbox: null }));
    assert.equal(compressionToolsForMedia("image/png").join(), "sharp");
    assert.deepEqual(compressionToolsForMedia("application/pdf"), ["qpdf", "java", "pdfbox"]);
    const capability = {
      budget: "enforced" as const,
      missing: ["java", "qpdf", "pdfbox"],
      diskFreeBytes: 8 * 1024 * 1024 * 1024,
    };
    assert.equal(compressionFileReady("image/jpeg", capability), true);
    assert.equal(compressionFileReady("application/pdf", capability), false);
    assert.equal(compressionPolicyFingerprint({ version: "only-a-label" }), compressionPolicyFingerprint({ version: "other-label" }));
  });

  it("accepts only the pinned qpdf release", () => {
    assert.equal(qpdfVersionMatches(`qpdf version ${QPDF_REQUIRED_VERSION}`), true);
    assert.equal(qpdfVersionMatches(`qpdf version ${QPDF_REQUIRED_VERSION}.1`), false);
    assert.equal(qpdfVersionMatches("qpdf version 11.9.1"), false);
    assert.equal(qpdfVersionMatches("qpdf 12.4.2"), false);
    assert.equal(qpdfVersionMatches(null), false);
  });

  it("normalizes EXIF, keeps ICC and alpha, and rejects a second frame", async () => {
    const dir = makeTestTempDir("beian-image-worker-");
    mkdirSync(dir, { recursive: true });
    const oriented = join(dir, "oriented.jpg");
    const orientedOut = join(dir, "oriented-out.jpg");
    await sharp({ create: { width: 12, height: 6, channels: 3, background: "red" } })
      .jpeg()
      .withMetadata({ orientation: 6, icc: "p3" })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="6"/></rdf:RDF></x:xmpmeta>')
      .toFile(oriented);
    const originalMeta = await sharp(oriented).metadata();
    const turned = await runWorker(oriented, orientedOut, "image/jpeg");
    assert.equal(turned.status, 0);
    const turnedMeta = await sharp(orientedOut).metadata();
    assert.equal(turnedMeta.width, 6);
    assert.equal(turnedMeta.height, 12);
    assert.ok(turnedMeta.orientation == null || turnedMeta.orientation === 1);
    assert.ok(turnedMeta.hasProfile || (turnedMeta.icc && turnedMeta.icc.length > 0));
    assert.deepEqual(turnedMeta.icc, originalMeta.icc, "keep the actual source colour profile");
    assert.equal(turnedMeta.xmp, undefined, "discard stale XMP orientation after rotating pixels");

    const mirrored = join(dir, "mirror.jpg");
    const mirroredOut = join(dir, "mirror-out.jpg");
    await sharp({ create: { width: 10, height: 4, channels: 3, background: "blue" } })
      .jpeg()
      .withMetadata({ orientation: 2 })
      .toFile(mirrored);
    assert.equal((await runWorker(mirrored, mirroredOut, "image/jpeg")).status, 0);
    const mirrorMeta = await sharp(mirroredOut).metadata();
    assert.equal(mirrorMeta.width, 10);
    assert.equal(mirrorMeta.height, 4);

    const png = join(dir, "alpha.png");
    const pngOut = join(dir, "alpha-out.png");
    await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.4 } } }).png().toFile(png);
    assert.equal((await runWorker(png, pngOut, "image/png")).status, 0);
    assert.equal((await sharp(pngOut).metadata()).hasAlpha, true);

    const red = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
    const blue = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
    const animated = join(dir, "anim.webp");
    await sharp([red, blue], { join: { animated: true } }).webp({ delay: [40, 40] }).toFile(animated);
    const rejected = await runWorker(animated, join(dir, "anim-out.webp"), "image/webp");
    assert.equal(rejected.status, 4);
    assert.equal(readFileSync(javaSource, "utf8").includes("PDFRenderer"), false);
  });

  it("does not publish an image when this platform cannot enforce the memory budget", async () => {
    process.env.VITEST = "1";
    const dir = makeTestTempDir("beian-image-budget-");
    const source = join(dir, "a.jpg");
    const output = join(dir, "a-out.jpg");
    await sharp({ create: { width: 3, height: 3, channels: 3, background: "white" } }).jpeg().toFile(source);
    setCompressionExecutorForTest(null);
    const result = await executeCompressionFile({
      batchId: "abcabcabcabc",
      file: {
        id: "asset1",
        name: "a.jpg",
        media_type: "image/jpeg",
        status: "running",
        input_bytes: statSync(source).size,
        output_bytes: null,
        reason: null,
        sha256: "0".repeat(64),
        manual_retries: 0,
        last_retry_at: null,
        policy_fingerprint: compressionPolicyFingerprint(),
        tool_generation: "tools",
      },
      sourcePath: source,
      outputPath: output,
      token: "token",
      signal: new AbortController().signal,
      capability: {
        budget: "enforced",
        mechanism: "test",
        toolsReady: true,
        missing: [],
        diskFreeBytes: 8 * 1024 * 1024 * 1024,
        toolGeneration: "tools",
        policyFingerprint: "policy",
        versions: { sharp: "0.34.4", qpdf: null, java: null, pdfbox: null },
      },
    });
    if (process.platform === "darwin") {
      assert.equal(result.reason, "platform_budget_unavailable");
      assert.equal(result.publish, "none");
      assert.equal(statOk(output), false);
    } else if (result.publish === "none") {
      assert.ok(result.reason === "platform_budget_unavailable" || result.reason === "dependency_missing");
    }
  });

  it("uses the saved execution budgets in each child command", () => {
    const saved = { ...compressionPolicySnapshot(), rss_bytes: 64 * 1024 ** 2, pdf_max_ms: 30_000,
      java_xmx_bytes: 32 * 1024 ** 2, max_image_pixels: 100, max_image_decode_bytes: 400 };
    const image = imageWorkerCommand("in.png", "out.png", "image/png", saved);
    assert.equal(image[image.indexOf("--max-pixels") + 1], "100");
    assert.equal(image[image.indexOf("--max-decode-bytes") + 1], "400");
    const args = containArgs(image, "attempt", saved);
    assert.equal(args[args.indexOf("--as") + 1], String(saved.rss_bytes));
    assert.equal(args[args.indexOf("--cpu") + 1], "30");
    const java = javaHelperCommand("java", "pdfbox.jar", "inspect", ["in.pdf"], saved);
    assert.ok(java.includes("-Xmx32m"));
    assert.equal(java.at(-1), "200,100000,32,100,400,1073741824");
  });
});

function statOk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

it("requires the executed tree budget and group budget, never accepted rlimit flags", () => {
  assert.equal(budgetFromProbe({ as: true, rss: true, data: true } as never).budget, "unavailable");
  const proof = { enforced: true, mechanism: "windows-job-commit+tree-rss-monitor", tree_bytes: 768 * 1024 ** 2, group_bytes: 1024 ** 3 };
  assert.equal(budgetFromProbe(proof).budget, "enforced");
  assert.equal(budgetFromProbe({ ...proof, group_bytes: undefined }).budget, "unavailable");
  assert.equal(budgetFromProbe({ ...proof, mechanism: "rlimit:rss" }).budget, "unavailable");
  const argv = containArgs(["/safe/helper", "input.pdf"], "/owned/attempt");
  assert.equal(argv[argv.indexOf("--group-memory") + 1], String(1024 ** 3));
  assert.equal(argv[argv.indexOf("--fsize") + 1], String(128 * 1024 ** 2));
  assert.equal(argv[argv.indexOf("--work-dir") + 1], "/owned/attempt");
});
