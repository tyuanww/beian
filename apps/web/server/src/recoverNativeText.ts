/**
 * Admin-only CLI: release a native-text request stuck in running +
 * close_unconfirmed after the Illustrator host was restarted. Run on the
 * production host from an elevated shell, with WB_DATA_DIR set, only after an
 * administrator has confirmed Illustrator has no customer documents open:
 *
 *   node_modules\.bin\tsx.cmd apps/web/server/src/recoverNativeText.ts --task <task id> --attempt <32-hex id> --confirm-no-open-documents
 *
 * Exit 0 only when the record was recovered. No HTTP route can reach this.
 */
import { adminRecoverNativeRequest, nativeRequest } from "./nativeTextJobs.js";
import { loadTask } from "./tasks.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const task = arg("--task");
const attempt = arg("--attempt");
if (!task || !/^[0-9a-f]{12}$/.test(task) || !attempt || !/^[0-9a-f]{32}$/.test(attempt)) {
  console.error("usage: --task <12-hex task id> --attempt <32-hex attempt id> --confirm-no-open-documents");
  process.exit(2);
}
if (!process.argv.includes("--confirm-no-open-documents")) {
  console.error("refused: an administrator must confirm Illustrator has no open customer documents (--confirm-no-open-documents)");
  process.exit(2);
}
let outcome: string;
try {
  outcome = adminRecoverNativeRequest(task, attempt);
} catch (err) {
  console.error(`refused: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
// Task JSON has no file lock. Recovery aborts if the file changed during the
// worker check and then compares and writes synchronously; re-read once more
// to prove the recovery actually landed.
if (outcome === "recovered") {
  const after = nativeRequest(loadTask(task));
  if (after?.id !== attempt || after.status !== "fallback") outcome = "overwritten_concurrently";
}
console.log(JSON.stringify({ task, attempt, outcome }));
if (outcome === "changed_during_check" || outcome === "overwritten_concurrently") {
  console.error("refused: the task changed while checking; nothing was overwritten. Confirm no one is reviewing (or stop 8787) and retry.");
}
process.exit(outcome === "recovered" ? 0 : 1);
