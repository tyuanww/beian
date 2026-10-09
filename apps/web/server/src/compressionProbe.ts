import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pythonBin } from "./settings.js";
import { DATA_DIR } from "./config.js";
import {
  COMPRESSION_REQUIRED_FREE_BYTES,
  COMPRESSION_RSS_BYTES,
  COMPRESSION_GROUP_RSS_BYTES,
  compressionPolicyFingerprint,
} from "./compressionPolicy.js";

const require = createRequire(import.meta.url);
const CONTAIN = join(dirname(fileURLToPath(import.meta.url)), "../tools/compression/contain.py");

export type CompressionBudget = "enforced" | "unavailable";

export type CompressionCapability = {
  budget: CompressionBudget;
  mechanism: string;
  toolsReady: boolean;
  missing: string[];
  diskFreeBytes: number;
  toolGeneration: string;
  policyFingerprint: string;
  versions: {
    sharp: string | null;
    qpdf: string | null;
    java: string | null;
    pdfbox: string | null;
  };
};

export type RlimitProbe = {
  enforced: boolean;
  mechanism: string;
  tree_bytes?: number;
  group_bytes?: number;
};

let override: CompressionCapability | null = null;
let cached: { at: number; value: CompressionCapability } | null = null;

export function setCompressionCapabilityForTest(next: CompressionCapability | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩能力测试钩子只能在 VITEST 使用");
  override = next;
  cached = null;
}

function diskFreeBytes(path = DATA_DIR): number {
  mkdirSync(path, { recursive: true });
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function pythonCandidates(): string[] {
  const home = process.env.HOME || "";
  return [
    pythonBin(),
    process.env.BEIAN_PYTHON || "",
    "python3",
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    home ? join(home, "homebrew/bin/python3") : "",
  ].filter((item) => item.length > 0);
}

/** 真实执行 contain.py --probe。文件大小和 CPU 限制不算驻留内存预算。 */
export function probeResourceLimits(): { report: RlimitProbe | null; python: string | null } {
  if (!existsSync(CONTAIN)) return { report: null, python: null };
  for (const python of pythonCandidates()) {
    const run = spawnSync(python, [CONTAIN, "--probe"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (run.status !== 0 || !run.stdout) continue;
    try {
      const parsed = JSON.parse(run.stdout) as Partial<RlimitProbe>;
      return {
        python,
        report: {
          enforced: parsed.enforced === true,
          mechanism: typeof parsed.mechanism === "string" ? parsed.mechanism : "platform-budget-unavailable",
          tree_bytes: parsed.tree_bytes,
          group_bytes: parsed.group_bytes,
        },
      };
    } catch {
      continue;
    }
  }
  return { report: null, python: null };
}

export function budgetFromProbe(report: RlimitProbe | null): { budget: CompressionBudget; mechanism: string } {
  if (report?.enforced === true && report.tree_bytes === COMPRESSION_RSS_BYTES && report.group_bytes === COMPRESSION_GROUP_RSS_BYTES
      && ["windows-job-commit+tree-rss-monitor", "cgroup-v2-memory.max"].includes(report.mechanism)) {
    return { budget: "enforced", mechanism: report.mechanism };
  }
  return { budget: "unavailable", mechanism: "platform-budget-unavailable" };
}

function commandVersion(command: string, args: string[]): string | null {
  const run = spawnSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
  const text = `${run.stdout || ""}\n${run.stderr || ""}`.trim();
  if (!text || /unable to locate a java runtime/i.test(text)) return null;
  if (run.error || (run.status !== 0 && command !== "java")) return null;
  if (command === "java" && run.status !== 0) return null;
  const line = text.split(/\r?\n/).find((item) => item.trim()) || "";
  return line.trim().slice(0, 160) || null;
}

function sharpVersion(): string | null {
  try {
    const packageJson = require.resolve("sharp/package.json");
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function pdfboxJar(): string | null {
  const configured = process.env.BEIAN_PDFBOX_JAR || "";
  if (configured && existsSync(configured)) return configured;
  const bundled = join(dirname(CONTAIN), "pdfbox.jar");
  return existsSync(bundled) ? bundled : null;
}

export function toolGenerationOf(input: {
  mechanism: string;
  sharp: string | null;
  qpdf: string | null;
  java: string | null;
  pdfbox: string | null;
}): string {
  const present = (["sharp", "qpdf", "java", "pdfbox"] as const).filter((name) => {
    const version = input[name];
    return typeof version === "string" && version.length > 0;
  });
  return createHash("sha256")
    .update(JSON.stringify({ mechanism: input.mechanism, tools: present }))
    .digest("hex");
}

export function assessCapabilityNow(): CompressionCapability {
  if (override) return override;
  const probed = probeResourceLimits();
  const decision = budgetFromProbe(probed.report);
  const versions = {
    sharp: sharpVersion(),
    qpdf: commandVersion("qpdf", ["--version"]),
    java: commandVersion("java", ["-version"]),
    pdfbox: pdfboxJar(),
  };
  const missing = [
    versions.sharp ? "" : "sharp",
    versions.qpdf ? "" : "qpdf",
    versions.java ? "" : "java",
    versions.pdfbox ? "" : "pdfbox",
  ].filter((item) => item.length > 0);
  const disk = diskFreeBytes();
  const value: CompressionCapability = {
    budget: decision.budget,
    mechanism: decision.mechanism,
    toolsReady: decision.budget === "enforced" && missing.length === 0 && disk >= COMPRESSION_REQUIRED_FREE_BYTES,
    missing,
    diskFreeBytes: disk,
    toolGeneration: toolGenerationOf({ mechanism: decision.mechanism, ...versions }),
    policyFingerprint: compressionPolicyFingerprint(),
    versions,
  };
  cached = { at: Date.now(), value };
  return value;
}

export function assessCapability(): CompressionCapability {
  if (override) return override;
  if (cached && Date.now() - cached.at < 5_000) return cached.value;
  return assessCapabilityNow();
}
