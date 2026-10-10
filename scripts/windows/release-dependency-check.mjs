import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MANIFEST_PATHS = [
  "package.json",
  "apps/web/ui/package.json",
  "apps/web/server/package.json",
];
const DEPENDENCY_KEYS = [
  "workspaces",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "overrides",
  "engines",
  "os",
  "cpu",
  "packageManager",
];

function assertRevision(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value.includes("..")) {
    throw new Error("revision is invalid");
  }
  return value;
}

function readRevisionJson(root, revision, path) {
  const text = execFileSync(
    "git",
    ["-C", root, "show", `${revision}:${path}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(text);
}

function readTreeJson(directory, path) {
  return JSON.parse(readFileSync(join(directory, ...path.split("/")), "utf8").replace(/^\uFEFF/, ""));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function dependencyProjection(manifest) {
  return Object.fromEntries(
    DEPENDENCY_KEYS.filter((key) => Object.hasOwn(manifest, key)).map((key) => [key, manifest[key]]),
  );
}

function fingerprintFromReader(readJson) {
  const lock = readJson("package-lock.json");

  // A release version bump updates only the root package versions. They are not
  // dependency graph changes; every package entry and manifest dependency field
  // remains part of the canonical hash. Node's JSON parser intentionally handles
  // npm lockfiles' required empty-string packages[""] key on Windows PS5.1 hosts.
  delete lock.version;
  if (lock.packages?.[""] && typeof lock.packages[""] === "object") {
    delete lock.packages[""].version;
  }

  const manifests = Object.fromEntries(
    MANIFEST_PATHS.map((path) => [path, dependencyProjection(readJson(path))]),
  );
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ lock, manifests })), "utf8")
    .digest("hex");
}

function dependencyFingerprint(rootInput, revisionInput) {
  const root = resolve(rootInput);
  const revision = assertRevision(revisionInput);
  return fingerprintFromReader((path) => readRevisionJson(root, revision, path));
}

// The same canonical projection, read from an exported source tree on disk.
// release.ps1 uses it to prove the staged `git archive` matches TargetSha.
function treeFingerprint(directoryInput) {
  const directory = resolve(directoryInput);
  return fingerprintFromReader((path) => readTreeJson(directory, path));
}

function platformListAllows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const positives = list.filter((entry) => typeof entry === "string" && !entry.startsWith("!"));
  return positives.length === 0 || positives.includes(value);
}

function appliesToThisPlatform(entry) {
  return platformListAllows(entry.os, process.platform) && platformListAllows(entry.cpu, process.arch);
}

function isInstalledPackagePath(path) {
  return path.startsWith("node_modules/") || path.includes("/node_modules/");
}

function packageNameFromPath(path) {
  const index = path.lastIndexOf("node_modules/");
  return path.slice(index + "node_modules/".length);
}

// Names that an installed package (or a workspace manifest) asks for. An optional
// lock entry nobody installed asks for was skipped together with its platform-only
// parent (e.g. @img/sharp-wasm32 -> @emnapi/runtime -> tslib) and may be absent.
function requestedNames(expected, installed) {
  const names = new Set();
  const collect = (entry) => {
    for (const key of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(entry?.[key] ?? {})) names.add(name);
    }
  };
  for (const [path, entry] of Object.entries(expected)) {
    if (!isInstalledPackagePath(path)) collect(entry);
  }
  for (const [path, entry] of Object.entries(installed)) {
    if (isInstalledPackagePath(path)) collect(entry);
  }
  return names;
}

// Compare npm's hidden lockfile (written by `npm ci` into node_modules) with the
// target revision's package-lock.json. Every lock entry that applies to this
// OS/CPU must be installed with the same version/resolved/integrity/link; an
// installed entry the target lock does not know is an unverified graph.
function installedProblems(directoryInput, rootInput, revisionInput) {
  const directory = resolve(directoryInput);
  const root = resolve(rootInput);
  const revision = assertRevision(revisionInput);
  const lock = readRevisionJson(root, revision, "package-lock.json");
  const hidden = readTreeJson(directory, "node_modules/.package-lock.json");
  const expected = lock.packages ?? {};
  const installed = hidden.packages ?? {};
  const problems = [];
  const requested = requestedNames(expected, installed);
  for (const [path, entry] of Object.entries(expected)) {
    if (!isInstalledPackagePath(path)) continue;
    const actual = installed[path];
    if (!actual) {
      if (!appliesToThisPlatform(entry)) continue;
      const optional = entry.optional === true || entry.devOptional === true;
      if (optional && !requested.has(packageNameFromPath(path))) continue;
      problems.push(`missing:${path}`);
      continue;
    }
    if ((actual.version ?? "") !== (entry.version ?? "")) problems.push(`version:${path}`);
    if (Boolean(actual.link) !== Boolean(entry.link)) problems.push(`link:${path}`);
    for (const key of ["resolved", "integrity"]) {
      if (actual[key] && entry[key] && actual[key] !== entry[key]) problems.push(`${key}:${path}`);
    }
  }
  for (const path of Object.keys(installed)) {
    if (isInstalledPackagePath(path) && !Object.hasOwn(expected, path)) problems.push(`extraneous:${path}`);
  }
  return problems;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "fingerprint" && rest.length === 2) {
    process.stdout.write(`${dependencyFingerprint(rest[0], rest[1])}\n`);
    return;
  }
  if (command === "fingerprint-tree" && rest.length === 1) {
    process.stdout.write(`${treeFingerprint(rest[0])}\n`);
    return;
  }
  if (command === "installed" && rest.length === 3) {
    const problems = installedProblems(rest[0], rest[1], rest[2]);
    if (problems.length > 0) {
      throw new Error(`installed tree does not match ${rest[2]}: ${problems.slice(0, 8).join(", ")}`);
    }
    process.stdout.write(`${dependencyFingerprint(rest[1], rest[2])}\n`);
    return;
  }
  throw new Error(
    "usage: release-dependency-check.mjs fingerprint <repo-root> <revision> | fingerprint-tree <dir> | installed <dir> <repo-root> <revision>",
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release dependency check failed: ${message.slice(0, 300)}\n`);
  process.exitCode = 1;
}
