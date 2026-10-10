/** 出图记录下载提示。不挡点击。 */

export const HUD_MS = 2200;

export const FULL_UPGRADE_NOTICE = "高清图暂时未加载，重新打开此单可重试";

export type HudNoticeSource = "auto" | "action";

/** Auto upgrade notices are once per generation; a later download click must still be able to show the same copy. */
export function allowFullUpgradeNotice(
  alreadyShownFor: string,
  generation: string,
  source: HudNoticeSource,
): boolean {
  if (source === "action") return true;
  return alreadyShownFor !== generation;
}

export function downloadHudLine(label: string): string {
  const visible = label === "GLB" ? "模型" : label === "PPT" ? "演示稿" : label;
  return `正在下载${visible}`;
}

export function missingPptHud(): string {
  return "演示稿暂不可用，白底仍可下载";
}
