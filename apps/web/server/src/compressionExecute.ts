import type { CompressionCapability } from "./compressionProbe.js";
import { runCompressionJob } from "./compressionTools.js";
import type { CompressionFileRecord } from "./compressionStore.js";
import type { CompressionFileStatus } from "./compressionModel.js";

export type CompressionExecuteRequest = {
  batchId: string;
  file: CompressionFileRecord;
  sourcePath: string;
  outputPath: string;
  token: string;
  signal: AbortSignal;
  capability: CompressionCapability;
};

export type CompressionExecuteResult = {
  status: CompressionFileStatus;
  reason: string | null;
  publish: "copy_source" | "output" | "none";
};

export type CompressionExecutor = (request: CompressionExecuteRequest) => Promise<CompressionExecuteResult>;

let testExecutor: CompressionExecutor | null = null;

export function setCompressionExecutorForTest(executor: CompressionExecutor | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩执行测试钩子只能在 VITEST 使用");
  testExecutor = executor;
}

/**
 * 测试钩子只替换这一层。生产路径在预算没强制时直接失败，
 * 工具齐备时才进入 contain.py 里的 Sharp、qpdf 或 PDFBox。
 */
export async function executeCompressionFile(request: CompressionExecuteRequest): Promise<CompressionExecuteResult> {
  if (testExecutor) return testExecutor(request);
  if (request.capability.budget !== "enforced") {
    return { status: "failed", reason: "platform_budget_unavailable", publish: "none" };
  }
  return runCompressionJob(request);
}
