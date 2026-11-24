/** 出图记录下载提示。不挡点击。 */

export const HUD_MS = 2200;

export const FULL_UPGRADE_NOTICE = "高清图暂时未加载，重新打开此单可重试";
export const STUDIO_DOWNLOAD_PREPARING = "正在准备成片";
export const STUDIO_DOWNLOAD_FAILED = "成片下载失败，请重试";

export function allowFullUpgradeNotice(alreadyShownFor: string | null, generation: string): boolean {
  return alreadyShownFor !== generation;
}

export function downloadHudLine(label: string): string {
  const visible = label === "GLB" ? "模型" : label === "PPT" ? "演示稿" : label;
  return `正在下载${visible}`;
}

export function missingPptHud(): string {
  return "演示稿暂不可用，白底仍可下载";
}
