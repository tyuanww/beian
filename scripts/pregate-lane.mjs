#!/usr/bin/env node
/**
 * Local pregate lane for a mixed Node and pytest selection.
 * Playwright e2e is not run: its webServer binds 127.0.0.1:5173.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2).filter(Boolean);
const e2e = [];
const server = [];
const ui = [];
const backend = [];
const quality = [];
const stress = [];
const unknown = [];

for (const file of files) {
  if (file.includes("/e2e/")) e2e.push(file);
  else if (file.startsWith("apps/web/server/") && file.endsWith(".ts")) server.push(file.slice("apps/web/server/".length));
  else if (file.startsWith("apps/web/ui/") && file.endsWith(".ts")) ui.push(file.slice("apps/web/ui/".length));
  else if (file.startsWith("apps/web/backend/") && file.endsWith(".py")) backend.push(file.slice("apps/web/backend/".length));
  else if (file.startsWith("scripts/quality/") && file.endsWith(".mjs")) quality.push(file);
  else if (file.startsWith("scripts/resource-stress/") && file.endsWith(".py")) stress.push(file);
  else unknown.push(file);
}

if (unknown.length) {
  console.error(`pregate-lane: no command for ${unknown.join(" ")}`);
  process.exit(1);
}
if (e2e.length) {
  console.log(`pregate-lane: skip ${e2e.length} e2e file(s); playwright webServer binds 127.0.0.1:5173`);
  for (const file of e2e) console.log(`pregate-lane: skip ${file}`);
}

const tsx = resolve(root, "node_modules/.bin/tsx");
const python = resolve(root, "apps/web/backend/.venv/bin/python");
if (!existsSync(tsx) || !existsSync(python)) {
  console.error("pregate-lane: missing tsx or apps/web/backend/.venv");
  process.exit(1);
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  const code = result.status ?? 1;
  if (code !== 0) process.exit(code);
}

if (server.length) run(tsx, ["--test", ...server], resolve(root, "apps/web/server"));
if (ui.length) run(tsx, ["--test", ...ui], resolve(root, "apps/web/ui"));
if (quality.length) run(process.execPath, ["--test", ...quality], root);
if (backend.length) run(python, ["-m", "pytest", "-q", ...backend], resolve(root, "apps/web/backend"));
if (stress.length) run(python, ["-m", "pytest", "-q", ...stress.map((file) => resolve(root, file))], root);
if (!server.length && !ui.length && !quality.length && !backend.length && !stress.length) {
  console.error("pregate-lane: no unit files to run");
  process.exit(1);
}
