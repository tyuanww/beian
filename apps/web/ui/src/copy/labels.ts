/**
 * 后台菜单与状态文案的唯一出处。
 *
 * 规则：代码判断只用英文 key（NavKey / 后端状态值 / WaitKind），这里只负责“显示成什么字”。
 * 改字只动本文件，不要把中文再写回比较、类型或 localStorage。
 * 后端回传的中文（阶段名、设置分组、净含量等）只在显示层转换，不改值。
 */
import type { WaitKind } from "../pages/waitCard";

export type NavKey = "review" | "mockup" | "compression" | "history" | "settings";

/** 侧栏菜单名；页面标题、加载提示、读屏标签都从这里取，避免半新半旧。 */
export const NAV_LABEL: Record<NavKey, string> = {
  review: "审稿",
  mockup: "3D 打样",
  compression: "压缩",
  history: "历史记录",
  settings: "设置",
};

/**
 * 等待卡标题。⚠ 必须保持 3 个字：waitLoaderLetters() 把它逐字拆到等待圆盘上，
 * 圆盘按 3 个字排版。改字数要同时改 WaitLoader 的样式和 waitCard.test.ts。
 */
export const WAIT_TITLE: Record<WaitKind, string> = {
  compare: "检查中",
  rework: "复核中",
  mockup: "生成中",
};

/** 审稿单状态（key 是后端 status 值）。 */
export const REVIEW_STATUS_LABEL = {
  comparing: "检查中",
  reworking: "复核中",
  compare_failed: "检查失败",
  pending: "待确认",
  /** complete_kind 缺失或未知（老记录）时的完成态，保持原叫法。 */
  completed: "已提交",
  signed: "已通过",
  rework: "已退回",
} as const;

/**
 * 审稿完成态按 job 字段 complete_kind 区分：signed → 已通过，rework → 已退回；
 * 老记录没有 complete_kind 或值未知时保持「已提交」。后端不变。
 * 注意：打样侧后端阶段文案「已提交」（server/src/jobs.ts）与此无关，不要改。
 */
export function reviewCompletedLabel(completeKind?: string | null): string {
  if (completeKind === "signed") return REVIEW_STATUS_LABEL.signed;
  if (completeKind === "rework") return REVIEW_STATUS_LABEL.rework;
  return REVIEW_STATUS_LABEL.completed;
}

/** 打样单状态。 */
export const MOCKUP_STATUS_LABEL = {
  running: "生成中",
  done: "已完成",
  needFront: "选个正面",
  failed: "生成失败",
  unsupported: "暂不支持此盒型",
  interrupted: "生成中断",
} as const;

/** 压缩文件状态（key 是后端 status 值）。 */
export const COMPRESSION_STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "压缩中",
  succeeded: "已完成",
  passthrough: "无需压缩",
  unmet_target: "压不到 10MB",
  unsupported: "不支持",
  failed: "失败",
  done: "已完成",
  partial: "部分完成",
};
