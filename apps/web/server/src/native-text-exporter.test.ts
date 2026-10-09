import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
const source = readFileSync(resolve(import.meta.dirname, "../../../../workers/packaging/illustrator/export_structure.jsx"), "utf8");
const fn = source.slice(source.indexOf("function exportNativeText("), source.indexOf("function withConfiguredPrintLayers("));
function extract(options: { hidden?: boolean; clipped?: boolean; occluded?: boolean; fontMissing?: boolean } = {}) {
  const doc = { typename: "Document", artboards: [{ artboardRect: [10, 200, 310, 0] }], textFrames: [] as unknown[], pageItems: [] as unknown[], saveAs: () => undefined };
  const layer = { typename: "Layer", parent: doc, visible: true, clipped: options.clipped };
  const frame = { typename: "TextFrame", parent: layer, contents: "原稿文字", visibleBounds: [40, 160, 120, 130], hidden: options.hidden, opacity: 100,
    characters: [{ characterAttributes: { textFont: { name: "FixtureFont" } } }] };
  doc.textFrames.push(frame); doc.pageItems.push(frame);
  if (options.occluded) doc.pageItems.push({ typename: "PlacedItem", parent: layer, visibleBounds: [40, 160, 120, 130], opacity: 100 });
  const result = { attempt_id: "a".repeat(32) };
  runInNewContext(fn + "\nexportNativeText(doc, config, result)", { doc, result, config: { source_sha256: "b".repeat(64), print_pdf: "synthetic-output.pdf" },
    restoreUnattendedArtwork: () => undefined, hostState: {}, writeJobProgress: () => undefined, jsonStringify: JSON.stringify,
    PDFSaveOptions: function () {}, File: function () {}, app: { textFonts: { getByName: (name: string) => { if (options.fontMissing) throw new Error("missing"); return { name }; } } } });
  return JSON.parse(JSON.stringify(result));
}
it("native extractor emits explicit page transforms and stable text identity through the existing exporter", () => {
  const result = extract();
  assert.deepEqual(result.pages[0].transform, [1, 0, 0, -1, -10, 200]);
  assert.deepEqual(result.candidates[0].bbox, [30, 40, 110, 70]);
  assert.equal(result.candidates[0].visible, true);
  assert.equal(result.candidates[0].text, "原稿文字");
  assert.equal(result.close_confirmed, false);
});
it("hidden clipped covered and unavailable-font candidates cannot claim visibility evidence", () => {
  for (const options of [{ hidden: true }, { clipped: true }, { occluded: true }]) assert.equal(extract(options).candidates[0].visible, false);
  assert.equal(extract({ fontMissing: true }).candidates[0].font_available, false);
});
