import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { it } from "node:test";

const dir = resolve(import.meta.dirname, "../../../../workers/packaging/illustrator");
const source = readFileSync(resolve(dir, "export_structure.jsx"), "utf8");
const declarations = source.slice(0, source.indexOf("var configPath =")).replace(/^#include.*$/gm, "");
const host = readFileSync(resolve(dir, "unattended_host.jsx"), "utf8");

for (const stuck of [false, true]) it(`unfolded export restores artwork before saving; restore failure=${stuck}`, () => {
  let visible = true;
  const layer = { name: "印刷", get visible() { return visible; }, set visible(value: boolean) { if (!stuck || !value) visible = value; } };
  const helper = { name: "packaging:cut", hidden: false, typename: "PathItem", locked: false, parent: null };
  const saved: unknown[] = [];
  const doc = { layers: [layer], pageItems: [{ layer, hidden: false }, helper], artboards: [{ artboardRect: [0, 100, 200, 0] }], views: [{ zoom: 1 }],
    saveAs() { saved.push({ visible: layer.visible, helper: helper.hidden }); } };
  const result: { success?: boolean } = {};
  const run = () => runInNewContext(host + "\n" + declarations + "\nvar hostState = applyUnattendedHost(doc); exportCleanUnfoldedPrint(doc, config, result);", {
    doc, result, config: { protocol: "beian.illustrator.export/2", attempt_id: "a".repeat(32), source_sha256: "b".repeat(64), print_pdf: "synthetic.pdf" },
    File: function () {}, PDFSaveOptions: function () {}, app: { preferences: { getBooleanPreference() { return true; }, setBooleanPreference() {} }, executeMenuCommand() {} },
  });
  if (stuck) { assert.throws(run, /Cannot fully restore artwork layers/); assert.equal(saved.length, 0); }
  else { run(); assert.deepEqual(saved, [{ visible: true, helper: true }]); assert.equal(result.success, true); assert.equal(helper.hidden, false); }
});
