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
  review: "审稿台",
  mockup: "3D 打样",
  compression: "压缩文件",
  history: "历史",
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
  signed: "已签字",
  rework: "已退回",
} as const;

/**
 * 审稿完成态按 job 字段 complete_kind 区分：signed → 已签字，rework → 已退回；
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
  needFront: "待选正面",
  failed: "生成失败",
  unsupported: "结构暂不支持",
  interrupted: "生成中断",
} as const;

/** 压缩文件状态（key 是后端 status 值）。 */
export const COMPRESSION_STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  passthrough: "无需压缩",
  unmet_target: "压不到 10MB",
  unsupported: "不支持",
  failed: "处理失败",
  done: "已完成",
  partial: "部分完成",
};

/**
 * 核对页（A 通铺）文案。出处：prototypes-v2/deviations.md，老板 2026-10-11 已批
 * （第 3b、26–28、29、32、33、33b、34、35、35b 行）。确认框正文一字不改。
 */
export const REVIEW_COPY = {
  reject: "退回",
  sign: "签字",
  pendingHint: (n: number) => `还有 ${n} 条没下结论`,
  pendingTitle: (n: number) => `还有 ${n} 条没下结论，下完才能签字`,
  signBlockedByIssue: (n: number) => `有 ${n} 条标了有错，请退回`,
  rejectTitle: "退回这份稿？",
  rejectBody: (n: number) => `有错的 ${n} 条会随退回一起发出，并通知「已退回」。提交后不能撤回。`,
  rejectConfirm: "确认退回",
  signTitle: "签字这份稿？",
  signBody: "签字后会通知「已签字」，不能撤回。",
  signConfirm: "确认签字",
  cancel: "再看看",
  missingReason: "没写原因",
  extraNote: "补充说明（选填）",
  submitFailed: "没提交成功，请重试",
  retry: "重试",
  signConclusion: "无改稿项",
  rejectConclusion: (n: number) => `退回：${n} 条有错，见清单`,
  lead: "核对要点",
  marker: "标记",
  verdict: { confirm: "一致", issue: "有错", ignore: "忽略" } as Record<"confirm" | "issue" | "ignore", string>,
  ignoreTip: "忽略：机器标错了，或这条不需要按备案印（如工艺说明、版本号）。忽略的条目不进退回清单。",
  writeReason: "写原因（选填，退回时会带上）",
  undoToast: (label: string) => `已标为${label}，`,
  undo: "撤销",
  offline: "没连上网，这条没存上",
  saveFailed: "这条没存上",
  hiResFailed: "高清没加载出来",
  lowResFailed: "稿件没加载出来",
  zeroIssues: "✓ 没发现问题",
  heldHeader: (n: number) => `另有 ${n} 处待人工确认`,
  heldCollapse: (n: number) => `展开疑点 · 待人工确认 ${n}`,
  heldBar: (n: number) => `待人工确认 ${n}`,
  heldLine: (n: number) => `另有 ${n} 处机器没读准，签了表示人认这些字。`,
  verbatimNoneLead: "这轮没有要退的字",
  verbatimNoneNote: "只核了稿上的字在不在确认单里",
  reupload: "重新上传这一单",
  allDecided: "全部已下结论",
  /** 右栏「待确认」列表空态（产品哥 2026-10-11；核对栏一行提示不带句号）。 */
  pendingEmpty: "没有待确认的了",
  /** 提交失败按服务端状态/错误码映射；不把服务端原文给用户看。 */
  submitStillChecking: "这份稿还在检查，等一会儿再提交",
  submitPending: (n: number) => `还有 ${n} 条待确认，处理完才能签字`,
  rejectBlockedByPending: (n: number) => `还有 ${n} 条待确认，处理完才能退回`,
  collapse: "收起",
  expand: (n: number) => `展开疑点 · 待确认 ${n}`,
  tabs: { pending: "待确认", issue: "有错", all: "全部" },
  doubts: "疑点",
  shortcutsTitle: "快捷键",
  shortcutsGotIt: "知道了",
  phoneOnly: "逐条下结论仅电脑端",
  phoneIssues: (n: number) => `有错 ${n} 条`,
  /** 已被别人完成（锁页横幅 + 提交失败提示共用；项目哥/产品哥 2026-10-11 定稿）。 */
  lockedSign: (who: string) => `这一单已被${who}签字`,
  lockedRework: (who: string) => `这一单已被${who}退回，等新稿`,
  lockedOther: (who: string) => `这一单已被${who}处理`,
  lockedUnknown: "这份稿已经提交过了",
  /** 锁页横幅第二行（只留 🔒 一个图标）。 */
  lockedNote: "只能查看，不能再改",
  footer: (left: number, page: number) => `这单还剩 ${left} 条待确认 · 本页还有 ${page} 条`,
  spot: "就地对照",
  spotTitle: "对照贴在这条旁边",
  noBox: "没找到位置，请看整页",
  lineNotBoxed: "没框住这一行",
  pageSkew: "这一页方向对不上，框不准",
  heldUnread: "认不准的字",
  heldNote: "备注没对上",
  excelMissing: "确认单没有这段",
  spaceLabel: "空格",
} as const;
