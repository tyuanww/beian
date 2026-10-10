import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { compressionZipStream } from "./compressionZip.js";
import { makeTestTempDir } from "./testTemp.js";

it("ZIP declares UTF-8 in both headers so Chinese filenames round-trip", async () => {
  const path = join(makeTestTempDir("beian-compression-zip-"), "source");
  writeFileSync(path, "synthetic");
  const parts: Buffer[] = [];
  for await (const part of compressionZipStream([{ name: "检测报告.pdf", path }])) parts.push(part);
  const zip = Buffer.concat(parts);
  const central = zip.readUInt32LE(zip.length - 6);
  for (const [offset, flagsOffset, nameLengthOffset, nameOffset] of [[0, 6, 26, 30], [central, 8, 28, 46]]) {
    const flags = zip.readUInt16LE(offset + flagsOffset);
    assert.equal(flags & 0x800, 0x800);
    assert.equal(flags & 8, 8);
    const name = zip.subarray(offset + nameOffset, offset + nameOffset + zip.readUInt16LE(offset + nameLengthOffset));
    assert.equal(name.toString("utf8"), "检测报告.pdf");
  }
});
