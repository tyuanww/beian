import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
import { buildPngTexturedGlbForProbe, compressGlbTexturesToWebp, glbTextureFormat } from "./glbWebp.js";
import { createRenderGenerationBridge, type RenderBridgeValidation } from "./renderGenerationBridge.js";
import { renderGenerationProcessSupported } from "./renderGenerationProcess.js";
import { contentFingerprint, type QualityVerifyInput } from "./renderGenerations.js";

const faces = ["front", "right", "back", "left", "top", "bottom"] as const;
const sha = (b: string | Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const MAP: Record<string, string> = { front_right: "white_a", back_left: "white_b", glb: "glb", front_right_card: "white_a_card", back_left_card: "white_b_card" };

// Minimal transport double: writes synthetic outputs and reports their real hashes.
const worker = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
  const req=JSON.parse(input);
  const hash=b=>'sha256:'+crypto.createHash('sha256').update(b).digest('hex');const id=hash('plan');
  const result={ok:true,schema:'packaging-render-generation-result/1',action:req.action,mode:req.mode,
    source_identity:{resolved_job_sha256:req.expected_source_sha256,plan_identity:id,render_contract_hash:hash('contract'),
      render_profile_id:'synthetic-test',assets:req.expected_asset_sha256},
    candidate_plan_identity:id,candidate_identity:hash('candidate'),candidate_dir:req.candidate_dir||null,
    studio_adjustment:req.studio_adjustment||null,execution:{status:'validated',nonce:null},outputs:{},optional_warnings:[],
    quality:{status:'layered',wired:true,runtime_gate:'not-run',fixture_regression:'not-run',visual_observations:'not-run',human_acceptance:'pending',production_ready:false}};
  if(req.action==='render-candidate'){
    fs.mkdirSync(req.candidate_dir);
    for(const key of ['front_right','back_left','front_right_card','back_left_card','glb']){
      const f=path.join(req.candidate_dir,key);fs.writeFileSync(f,'synthetic-'+key);const b=fs.readFileSync(f);
      result.outputs[key]={path:f,sha256:hash(b),bytes:b.length};
    }
    result.execution={status:'rendered',nonce:'0123456789abcdef0123456789abcdef'};
    result.quality.runtime_gate='pass';
    result.quality.machine_metrics={runtime_integrity:'pass',fixture_regression:'not-run',visual_observations:'not-run'};
    result.artifact_checks={glb:'passed',full_card:'passed',source_sampling:'passed'};
  }
  console.log(JSON.stringify(result));
});`;

function fixture(compressGlb?: (path: string) => Promise<never> | ReturnType<typeof compressGlbTexturesToWebp>) {
  const root = makeTestTempDir("beian-render-glb-webp-");
  const jobRoot = join(root, "job");
  const packagingDir = join(root, "worker");
  for (const dir of [jobRoot, packagingDir, join(jobRoot, "assets"), join(jobRoot, ".render-generations")]) mkdirSync(dir);
  const assets = Object.fromEntries(faces.map((face) => [face, join(jobRoot, "assets", `panel_${face}.png`)]));
  for (const file of Object.values(assets)) writeFileSync(file, "synthetic-face");
  const raw = Buffer.from(JSON.stringify({ assets }));
  writeFileSync(join(jobRoot, "resolved_job.json"), raw);
  writeFileSync(join(packagingDir, "render_generation.py"), worker);
  const bridge = createRenderGenerationBridge({ pythonExecutable: process.execPath, packagingDir, dataRoot: root, timeoutMs: 20000, compressGlb });
  const input: RenderBridgeValidation = {
    jobRoot, mode: "legacy_relight", expectedSourceSha256: sha(raw),
    expectedAssetSha256: Object.fromEntries(faces.map((face) => [face, sha("synthetic-face")])) as RenderBridgeValidation["expectedAssetSha256"],
    studioAdjustment: { product_light: 1.2, background_light: 0.8 },
  };
  return { bridge, input, candidate: join(jobRoot, ".render-generations", ".candidate-test") };
}

async function renderAndProve(f: ReturnType<typeof fixture>) {
  const receipt = await f.bridge.verify(f.input);
  const candidate = await f.bridge.render(receipt, f.candidate, process.execPath);
  const files = Object.entries(candidate.outputs).map(([key, row]) => ({ key: MAP[key], sha256: row.sha256.slice(7), bytes: row.bytes }));
  const faceHashes = Object.fromEntries(faces.map((face) => [face, sha("synthetic-face").slice(7)])) as QualityVerifyInput["faces"];
  const proof = f.bridge.createPartialSealVerifier(candidate);
  const verdict = proof({ generation_id: "g1", contract_sha256: receipt.sourceSha256.slice(7), mode: "legacy_relight",
    files, faces: faceHashes, content_fingerprint: contentFingerprint(files, faceHashes) });
  return { candidate, verdict };
}

describe("render-generation GLB WebP before seal", { skip: !renderGenerationProcessSupported() }, () => {
  it("converts the candidate GLB before evidence capture so the seal proof binds the WebP bytes", async () => {
    const f = fixture(async (path) => {
      writeFileSync(path, await buildPngTexturedGlbForProbe(256)); // stand-in for a real Blender GLB
      return compressGlbTexturesToWebp(path);
    });
    const { candidate, verdict } = await renderAndProve(f);
    const glb = candidate.outputs.glb;
    const bytes = readFileSync(glb.path);
    assert.equal(glb.sha256, sha(bytes));
    assert.equal(glb.bytes, bytes.length);
    assert.equal(glbTextureFormat(glb.path), "webp");
    assert.equal(verdict.verifier_status, "accepted");
  });

  it("conversion failure keeps the worker GLB and its original evidence; generation still proves", async () => {
    const f = fixture(async () => { throw new Error("converter down"); });
    const { candidate, verdict } = await renderAndProve(f);
    assert.equal(readFileSync(candidate.outputs.glb.path, "utf8"), "synthetic-glb");
    assert.equal(candidate.outputs.glb.sha256, sha("synthetic-glb"));
    assert.equal(verdict.verifier_status, "accepted");
  });

  it("default converter skips a non-GLB without failing the candidate", async () => {
    const f = fixture();
    const { candidate, verdict } = await renderAndProve(f);
    assert.equal(candidate.outputs.glb.sha256, sha("synthetic-glb"));
    assert.equal(verdict.verifier_status, "accepted");
  });
});

describe("texture_format on a generation-managed glb entry", () => {
  it("reports webp for a sealed WebP generation GLB and png for a PNG one", async () => {
    process.env.WB_DATA_DIR = makeTestTempDir("beian-render-glb-webp-api-");
    const { saveMockup, readMockupFromDisk, publicMockup } = await import("./mockup.js");
    for (const [id, webp] of [["bb01bb01bb01", true], ["bb02bb02bb02", false]] as const) {
      const out = join(process.env.WB_DATA_DIR, "mockups", id, ".render-generations", "g1-legacy_relight-x", "outputs");
      mkdirSync(out, { recursive: true });
      const glbPath = join(out, "box.glb");
      writeFileSync(glbPath, await buildPngTexturedGlbForProbe(256));
      if (webp) assert.equal((await compressGlbTexturesToWebp(glbPath)).status, "converted");
      saveMockup({ id, status: "done", created_at: "2026-10-11T00:00:00Z", files: [{ key: "glb", path: glbPath, name: "box.glb" }],
        owner: "ou_gen", job_kind: "mockup", job_status: "succeeded", current_render_generation_id: "g1-legacy_relight-x" });
      const entry = publicMockup(readMockupFromDisk(id)!).files.find((file) => file.key === "glb");
      assert.deepEqual(entry, { key: "glb", name: "box.glb", texture_format: webp ? "webp" : "png" });
    }
  });
});
