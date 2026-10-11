import { NAV_LABEL, type NavKey } from "../copy/labels";

export type { NavKey };

export const SIDE_NAV: { key: NavKey; label: string; icon: string }[] = [
  { key: "review", label: NAV_LABEL.review, icon: "/brand/ui/nav-review.svg" },
  { key: "mockup", label: NAV_LABEL.mockup, icon: "/brand/ui/nav-mockup.svg" },
  { key: "compression", label: NAV_LABEL.compression, icon: "/brand/ui/nav-compression.svg" },
  { key: "history", label: NAV_LABEL.history, icon: "/brand/ui/nav-history.svg" },
  { key: "settings", label: NAV_LABEL.settings, icon: "/brand/ui/nav-settings.svg" },
];

/** 「设置」只给管理员（老板 2026-10-11 批准）。非管理员侧栏不出这一项。 */
export function sideNavFor(admin: boolean): typeof SIDE_NAV {
  return admin ? SIDE_NAV : SIDE_NAV.filter((item) => item.key !== "settings");
}

export function formatVersionLabel(version: string | null | undefined): string | null {
  const normalized = String(version || "").trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) ? `v${normalized}` : null;
}
