/** 上传回执、未完成会话和压缩非终态源件共用的占用量。各模块只登记自己的计数。 */

export type SourceUsage = { count: number; bytes: number };

export type SourceUsageProvider = () => {
  global: SourceUsage;
  owner: (owner: string) => SourceUsage;
};

const providers: SourceUsageProvider[] = [];

export function registerSourceUsageProvider(provider: SourceUsageProvider): void {
  if (!providers.includes(provider)) providers.push(provider);
}

export function additionalSourceUsage(owner: string): {
  ownerCount: number;
  ownerBytes: number;
  globalCount: number;
  globalBytes: number;
} {
  let ownerCount = 0;
  let ownerBytes = 0;
  let globalCount = 0;
  let globalBytes = 0;
  for (const provider of providers) {
    const usage = provider();
    const mine = usage.owner(owner);
    ownerCount += mine.count;
    ownerBytes += mine.bytes;
    globalCount += usage.global.count;
    globalBytes += usage.global.bytes;
  }
  return { ownerCount, ownerBytes, globalCount, globalBytes };
}
