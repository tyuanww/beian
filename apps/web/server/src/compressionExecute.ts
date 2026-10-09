import type { CompressionCapability } from "./compressionProbe.js";
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
 * 生产路径在工具模块接入前不会假装成功。
 * 预算没强制或工具不齐时返回真实失败，不发布字节。
 */
export async function executeCompressionFile(request: CompressionExecuteRequest): Promise<CompressionExecuteResult> {
  if (testExecutor) return testExecutor(request);
  const capability = request.capability;
  if (capability.budget !== "enforced") {
    return { status: "failed", reason: "platform_budget_unavailable", publish: "none" };
  }
  if (!capability.toolsReady || capability.missing.length > 0) {
    return { status: "failed", reason: "dependency_missing", publish: "none" };
  }
  return { status: "failed", reason: "dependency_missing", publish: "none" };
}
