/**
 * 旧打样 GLB WebP 旁路的两道静态护栏（方案 v2.1 §4.2）。
 *
 * A：jobs.ts 里每个 `live.blender = <非 null>` 都必须落在登记过的函数里，
 *    且这些函数（以及上游入口）都同步调用 dropGlbWebpVariant。新增占槽点或改函数名就红。
 * B：登记 server/src 与 workers/packaging 里全部写文件调用点（rename/writeFile/copyFile/
 *    os.replace/shutil/export_scene 等），并标出哪些会写 GLB。出现未登记的新调用点就红，
 *    作者必须说明它是否会写 GLB、是否需要先删旁路。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const REPO = join(SRC, "../../../..");
const JOBS = readFileSync(join(SRC, "jobs.ts"), "utf8");

const TOP_FN_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;

function enclosingTopLevelFunction(source: string, index: number): string {
  const lines = source.slice(0, index).split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = TOP_FN_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return "<module>";
}

function topLevelFunctionBody(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => {
    const m = TOP_FN_RE.exec(line);
    return Boolean(m && m[1] === name);
  });
  assert.ok(start >= 0, `jobs.ts 里找不到函数 ${name}`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== "}") end += 1;
  return lines.slice(start, end + 1).join("\n");
}

/** 会占用 Blender 槽位（live.blender = 非 null）的函数白名单。 */
const BLENDER_CLAIM_FUNCTIONS = [
  "claimPrintFaceRepair",
  "claimUnfoldedPublish",
  "claimGenerationMutation",
  "runGenerationMutation",
  "occupyUnconfirmedGenerationBlenderFence",
  "recoverInterruptedMutation",
  "tryStart",
  "claimMockup",
] as const;

/** 进入时必须同步删旁路的 10 个入口（§4.1）对应的全部函数。 */
const DROP_REQUIRED_FUNCTIONS = [
  ...BLENDER_CLAIM_FUNCTIONS,
  "retryMockup",
  "repairMockupPrintFaces",
  "recoverPrintFaceRepairsOnBoot",
  "recoverRenderGenerationsOnBoot",
  "relightMockupStudio",
] as const;

describe("static guard A: live.blender claim sites drop the webp variant", () => {
  it("every non-null live.blender assignment is inside a whitelisted function", () => {
    const re = /live\.blender\s*=(?!=)(?!\s*null\b)/g;
    const found: string[] = [];
    for (let m = re.exec(JOBS); m; m = re.exec(JOBS)) found.push(enclosingTopLevelFunction(JOBS, m.index));
    assert.equal(found.length, 11, `live.blender 非 null 赋值数量变了：${found.join(", ")}`);
    const unknown = found.filter((name) => !(BLENDER_CLAIM_FUNCTIONS as readonly string[]).includes(name));
    assert.deepEqual(unknown, [], "新的 Blender 占槽点必须登记到白名单并先调用 dropGlbWebpVariant");
    assert.deepEqual([...new Set(found)].sort(), [...BLENDER_CLAIM_FUNCTIONS].sort());
  });

  it("every entry function calls dropGlbWebpVariant", () => {
    const missing = DROP_REQUIRED_FUNCTIONS.filter((name) => !/\bdropGlbWebpVariant\(/.test(topLevelFunctionBody(JOBS, name)));
    assert.deepEqual(missing, [], `这些入口没有删旁路：${missing.join(", ")}`);
  });
});

type WriteSite = { file: string; code: string; glb: boolean };

/**
 * 全部写文件调用点。glb=true 表示会写 GLB（原件或旁路），其余为 JSON/PNG/PDF/上传等。
 * 新增调用点：先判断是否会写这单 job 的 GLB；会写就必须让调用路径先 dropGlbWebpVariant。
 */
const WRITE_SITES: WriteSite[] = [
  // ---- GLB 写入点 ----
  { file: "apps/web/server/src/glbWebp.ts", code: "writeFileSync(tmp, bytes);", glb: true }, // 压缩 tmp（原地或旁路）
  { file: "apps/web/server/src/glbWebp.ts", code: "renameSync(tmp, dest);", glb: true }, // 原地替换 / 旁路 outPath
  { file: "apps/web/server/src/renderGenerations.ts", code: "renameSync(stagingDir, destDir);", glb: true }, // 代际 staging→ready（代际目录，不在旁路范围）
  { file: "apps/web/server/src/glbWebpProbe.ts", code: "writeFileSync(path, await buildPngTexturedGlbForProbe(256));", glb: true }, // CI 探针，不在生产路径
  { file: "apps/web/server/src/glbWebpMemoryProbe.ts", code: "copyFileSync(process.argv[argIndex + 1], path);", glb: true }, // CI 探针
  { file: "apps/web/server/src/glbWebpMemoryProbe.ts", code: "writeFileSync(path, bytes);", glb: true }, // CI 探针
  { file: "workers/packaging/blender/render_job.py", code: "bpy.ops.export_scene.gltf(**gltf_kwargs)", glb: true },
  { file: "workers/packaging/blender/render_job.py", code: "bpy.ops.export_scene.gltf(**gltf_kwargs)", glb: true },
  { file: "workers/packaging/pipeline.py", code: "shutil.copyfile(src, temp_path)", glb: true }, // atomic_replace_file：重渲提交
  { file: "workers/packaging/pipeline.py", code: "os.replace(temp_path, dest)", glb: true },
  { file: "workers/packaging/pipeline.py", code: "shutil.copyfile(src, dest)", glb: true }, // _stream_copy_file：备份
  { file: "workers/packaging/pipeline.py", code: "shutil.copyfile(backup, temp_path)", glb: true }, // _restore_file_from_backup：回滚
  { file: "workers/packaging/pipeline.py", code: "os.replace(temp_path, dest)", glb: true },
  // ---- 旁路 meta（JSON，不是 GLB） ----
  { file: "apps/web/server/src/glbWebpVariant.ts", code: "writeFileSync(tmp, JSON.stringify(meta));", glb: false },
  { file: "apps/web/server/src/glbWebpVariant.ts", code: "renameSync(tmp, metaPath);", glb: false },
  // ---- 其他（非 GLB） ----
  { file: "apps/web/server/src/aiRaster.ts", code: "fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));", glb: false },
  { file: "apps/web/server/src/aiRaster.ts", code: "writeFileSync(png, Buffer.from(\"89504e470d0a1a0a\", \"hex\"));", glb: false },
  { file: "apps/web/server/src/auth.ts", code: "writeFileSync(sessionsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });", glb: false },
  { file: "apps/web/server/src/auth.ts", code: "writeFileSync(", glb: false },
  { file: "apps/web/server/src/auth.ts", code: "writeFileSync(usersPath(), JSON.stringify({ users: list }, null, 2) + \"\\n\", { mode: 0o600 });", glb: false },
  { file: "apps/web/server/src/billing.ts", code: "writeFileSync(ledgerPath(), events.map((e) => JSON.stringify(e)).join(\"\\n\") + (events.length ? \"\\n\" : \"\"));", glb: false },
  { file: "apps/web/server/src/compressionStore.ts", code: "copyFileSync(file.path, dest, constants.COPYFILE_EXCL);", glb: false },
  { file: "apps/web/server/src/compressionStore.ts", code: "copyFileSync(from, tmp, constants.COPYFILE_EXCL);", glb: false },
  { file: "apps/web/server/src/compressionTools.ts", code: "try { writeFileSync(`${execution.closePath}.cancel`, execution.token); }", glb: false },
  { file: "apps/web/server/src/compressionTools.ts", code: "renameSync(candidate, request.outputPath);", glb: false },
  { file: "apps/web/server/src/historyIndex.ts", code: "renameSync(tmp, dest);", glb: false },
  { file: "apps/web/server/src/index.ts", code: "copyFileSync(excel.path, join(dir, \"source.xlsx\"));", glb: false },
  { file: "apps/web/server/src/index.ts", code: "copyFileSync(pdf.path, join(dir, \"artwork.pdf\"));", glb: false },
  { file: "apps/web/server/src/index.ts", code: "copyFileSync(ai.path, src);", glb: false },
  { file: "apps/web/server/src/index.ts", code: "writeFileSync(pdfPath, pdfBuf);", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "for (const face of files) renameSync(join(assets, `panel_${face}.png`), join(destination, `panel_${face}.png`));", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "copyFileSync(source.artwork, join(root, \"artwork.pdf\"));", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "copyFileSync(source.resolved, join(root, \"resolved.json\"));", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "renameSync(fromPath, dest);", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "if (previous) writeFileSync(dest, previous);", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "copyFileSync(join(jobRoot, UNFOLDED_SOURCE_NAME), sourceCopy);", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "copyFileSync(original, artwork);", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "copyFileSync(join(jobRoot, UNFOLDED_SOURCE_NAME), join(root, UNFOLDED_SOURCE_NAME));", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "copyFileSync(current.source_path || \"\", aiCopy);", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "writeFileSync(configPath, JSON.stringify({", glb: false },
  { file: "apps/web/server/src/jobs.ts", code: "writeFileSync(join(root, UNFOLDED_SOURCE_NAME), bytes);", glb: false },
  { file: "apps/web/server/src/mockup.ts", code: "copyFileSync(job.structure_artwork_preview_path, inputPreview);", glb: false },
  { file: "apps/web/server/src/mockupAtomicWrite.ts", code: "rename(tmp, target);", glb: false },
  { file: "apps/web/server/src/nativeTextJobs.ts", code: "copyFileSync(join(taskRoot(task), req.source_name), copy);", glb: false },
  { file: "apps/web/server/src/nativeTextJobs.ts", code: "writeFileSync(configPath, JSON.stringify({ protocol: \"beian.illustrator.export/2\", request_kind: \"native_text\",", glb: false },
  { file: "apps/web/server/src/releaseAdmission.ts", code: "writeFileSync(tempPath, `${JSON.stringify(payload)}\\n`, { encoding: \"utf8\", mode: 0o600 });", glb: false },
  { file: "apps/web/server/src/releaseAdmission.ts", code: "renameSync(tempPath, fencePath);", glb: false },
  { file: "apps/web/server/src/releaseAdmission.ts", code: "writeFileSync(path, `${JSON.stringify({", glb: false },
  { file: "apps/web/server/src/renderGenerationBudget.ts", code: "writeFileSync(`${path}.json`, JSON.stringify({ schema: \"render-reservation/1\", mutationId: input.mutationId,", glb: false },
  { file: "apps/web/server/src/settings.ts", code: "writeFileSync(path, JSON.stringify(data, null, 2) + \"\\n\", \"utf8\");", glb: false },
  { file: "apps/web/server/src/tasks.ts", code: "writeFileSync(tmp, contents, \"utf8\");", glb: false },
  { file: "apps/web/server/src/tasks.ts", code: "renameSync(tmp, dest);", glb: false },
  { file: "apps/web/server/src/tasks.ts", code: "copyFileSync(tmp, dest);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "writeFileSync(tmp, JSON.stringify(value), \"utf8\");", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(tmp, path);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "copyFileSync(tmp, path);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(src, taken);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "const output = createWriteStream(path, { flags: \"wx\" });", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(incomingDir, finalDir);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "writeFileSync(receiptPath(finalId), JSON.stringify(receipt), { encoding: \"utf8\", flag: \"wx\" });", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "writeFileSync(path, part.buf);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "writeFileSync(receiptPath(id), JSON.stringify(rec), { encoding: \"utf8\", flag: \"wx\" });", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "for (const file of files) writeFileSync(join(dir, file.storage_name), Buffer.alloc(0), { flag: \"wx\" });", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "writeFileSync(sessionPath(id), JSON.stringify(session), { encoding: \"utf8\", flag: \"wx\" });", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "copyFileSync(sessionFilePath(session, file), path);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "writeFileSync(receiptPath(id), JSON.stringify(receipt), { encoding: \"utf8\", flag: \"wx\" });", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(src, taken);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(taken, src);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(taken, src);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(markerPath, receiptPath(receipt.id));", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(markerPath, discarded);", glb: false },
  { file: "apps/web/server/src/uploads.ts", code: "renameSync(markerPath, receiptPath(id));", glb: false },
  { file: "workers/packaging/pipeline.py", code: "os.replace(temp_name, path)", glb: false }, // save_json
  { file: "workers/packaging/pipeline.py", code: "os.replace(temp_name, dest)", glb: false }, // write_review_card（PNG）
  { file: "workers/packaging/structure_v2/artwork.py", code: "os.replace(target, backup / f\"panel_{role}.png\")", glb: false },
  { file: "workers/packaging/structure_v2/artwork.py", code: "os.replace(source, target)", glb: false },
  { file: "workers/packaging/structure_v2/artwork.py", code: "os.replace(previous, target)", glb: false },
  { file: "workers/packaging/structure_v2/confirmation.py", code: "os.replace(temp_name, path)", glb: false },
  { file: "workers/packaging/structure_v2/repair.py", code: "os.replace(src, destination / f\"panel_{face}.png\")", glb: false },
  { file: "workers/packaging/structure_v2/resolver.py", code: "os.replace(temp_name, path)", glb: false },
  { file: "workers/packaging/structure_v2/unfolded_print.py", code: "os.replace(temporary, output)", glb: false }, // 展开稿 PDF
  { file: "workers/packaging/tools/render_quality_color_experiment.py", code: "os.replace(temp_name, dest)", glb: false },
  { file: "workers/packaging/tools/render_quality_color_experiment.py", code: "shutil.copyfile(source, anonymous_dir / f\"{key}.png\")", glb: false },
  { file: "workers/packaging/tools/render_quality_eval.py", code: "os.replace(temp_name, dest)", glb: false },
  { file: "workers/packaging/tools/render_quality_eval.py", code: "os.replace(temp_name, dest)", glb: false },
  { file: "workers/packaging/tools/render_quality_eval.py", code: "os.replace(temp_name, path)", glb: false },
  { file: "workers/packaging/tools/render_quality_eval.py", code: "os.replace(temp_name, path)", glb: false },
  { file: "workers/packaging/tools/render_quality_experiment.py", code: "os.replace(temp_name, dest)", glb: false },
  { file: "workers/packaging/tools/render_quality_experiment.py", code: "shutil.copyfile(source, target)", glb: false },
  { file: "workers/packaging/white_background.py", code: "os.replace(temp_name, source)", glb: false },
  { file: "workers/packaging/blender/render_job.py", code: "path.write_bytes(payload)", glb: false }, // 微法线 PNG
  { file: "workers/packaging/pipeline.py", code: "log_path.write_bytes(captured.stdout)", glb: false }, // 日志
  { file: "workers/packaging/pipeline.py", code: "log_path.write_bytes(error.output)", glb: false }, // 日志
];

const TS_WRITE_RE = /\b(?:renameSync|writeFileSync|copyFileSync|rename|writeFile|copyFile|cpSync|createWriteStream)\(/;
const PY_WRITE_RE = /\bos\.(?:replace|rename)\(|\bshutil\.(?:copy\w*|move)\(|\bexport_scene\.gltf\(|\.write_bytes\(/;

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, accept));
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out;
}

function scanWriteSites(): string[] {
  const sites: string[] = [];
  const add = (path: string, re: RegExp) => {
    const rel = relative(REPO, path).replace(/\\/g, "/");
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("#") || code.startsWith("*")) continue;
      if (re.test(code)) sites.push(`${rel} :: ${code}`);
    }
  };
  for (const path of listFiles(SRC, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) add(path, TS_WRITE_RE);
  for (const path of listFiles(join(REPO, "workers/packaging"), (name) => name.endsWith(".py"))) add(path, PY_WRITE_RE);
  return sites.sort();
}

describe("static guard B: registered file-write call sites (GLB writers)", () => {
  it("every write call site in server/src and workers/packaging is registered", () => {
    const expected = WRITE_SITES.map((site) => `${site.file} :: ${site.code}`).sort();
    const actual = scanWriteSites();
    const unregistered = actual.filter((site, i) => actual.indexOf(site) === i)
      .filter((site) => actual.filter((s) => s === site).length > expected.filter((s) => s === site).length);
    const stale = expected.filter((site, i) => expected.indexOf(site) === i)
      .filter((site) => expected.filter((s) => s === site).length > actual.filter((s) => s === site).length);
    assert.deepEqual({ unregistered, stale }, { unregistered: [], stale: [] },
      "写文件调用点变了：新调用点要登记并说明是否写 GLB（写 GLB 的路径必须先 dropGlbWebpVariant）");
  });

  it("GLB writer count is locked", () => {
    assert.equal(WRITE_SITES.filter((site) => site.glb).length, 13);
  });
});
