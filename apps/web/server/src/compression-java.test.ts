import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "./testTemp.js";

const java = process.env.WB_COMPRESSION_TEST_JAVA;
const jar = process.env.WB_COMPRESSION_TEST_PDFBOX;

// Test value: ★★★ — executes the PDF helper against synthetic documents to catch
// signature rewriting, repeated lossy encoding and cumulative decode overruns.
it("protects PDF signatures and recompresses shared images once within the saved budget", {
  skip: !java && !jar ? "supply an isolated Java 17+ and PDFBox 3.0.5 for the synthetic helper suite" : false,
}, () => {
  assert.ok(java && jar, "both WB_COMPRESSION_TEST_JAVA and WB_COMPRESSION_TEST_PDFBOX are required");
  const root = makeTestTempDir("beian-pdf-helper-");
  const classes = join(root, "classes");
  mkdirSync(classes);
  const helper = fileURLToPath(new URL("../tools/compression/PdfCompress.java", import.meta.url));
  const regression = fileURLToPath(new URL("../tools/compression/tests/PdfCompressRegression.java", import.meta.url));
  const compiled = spawnSync(join(dirname(java), process.platform === "win32" ? "javac.exe" : "javac"),
    ["-cp", jar, "-d", classes, helper, regression], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 });
  assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error || "javac did not finish"));
  const executed = spawnSync(java, ["-Xmx256m", "-cp", `${classes}${delimiter}${jar}`, "PdfCompressRegression", join(root, "fixtures")],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 });
  assert.equal(executed.status, 0, executed.stderr || String(executed.error || "Java did not finish"));
  assert.match(executed.stdout, /PDF_COMPRESS_SYNTHETIC_OK checks=\d+/);
});
