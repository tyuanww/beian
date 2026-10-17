/**
 * 后台菜单与状态文案的唯一出处。
 *
 * 规则：代码判断只用英文 key（NavKey / 后端状态值 / WaitKind），这里只负责“显示成什么字”。
 * 改字只动本文件，不要把中文再写回比较、类型或 localStorage。
 * 后端回传的中文（阶段名、设置分组、净含量等）只在显示层转换，不改值。
 */
import type { FeishuErrorCode } from "../loginFailure";
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

/**
 * 飞书登录失败页（拒绝页）的标题与兜底原因；key 是服务端回跳 URL 里的 `feishu_error` 码，
 * Record 按前端 `FeishuErrorCode` 穷尽：前端联合类型里加了码而这里不补会类型报错。
 * 服务端码是 URL 里的普通字符串，前端拿不到它的类型；服务端在 `apps/web/server/src/feishuLoginError.ts`
 * 列出全部码，两边是否一致由 `loginFailure.contract.test.ts` 对照（服务端加码不同步前端时该测试变红）。
 * 标题只按码选，不按原因文案选；
 * 原因优先显示服务端写的 `wb_login_hint`，cookie 没了才用 fallback。
 * 标题产品哥 2026-10-17 定稿：failed 与未知码/无码都是「暂时登录不了」，见 DESIGN.md「登录」。
 */
export const LOGIN_FAILURE_COPY: Record<FeishuErrorCode, { title: string; fallback: string }> = {
  /** 在飞书授权页点了拒绝。 */
  denied: { title: "授权未完成", fallback: "已取消飞书授权。" },
  /** 授权 state 找不到或已过期（授权页停太久、重复回调）。 */
  expired: { title: "登录已过期", fallback: "登录已过期，请再点一次。" },
  /** 403：非伸美企业、飞书身份无效、飞书号不在账号目录、账号已停用。 */
  forbidden: { title: "进不了这间审稿室", fallback: "只允许伸美公司的飞书号进入。" },
  /** 其余：换票失败、网络错误、账号目录故障（503：目录不可读、重复 open_id、角色无效）。 */
  failed: { title: "暂时登录不了", fallback: "飞书授权失败，请再试一次。" },
};

/** 回跳没带码或码不认识（服务端新码先于前端上线）时的兜底。 */
export const LOGIN_FAILURE_UNKNOWN = { title: "暂时登录不了", fallback: "飞书授权未完成。" } as const;

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
/** 生成人（建单人）。老任务没有记录时接口给 null，显示「未记录」，不拿账号 id 或签字人补。 */
export const CREATOR_UNRECORDED = "未记录";

/** 生成人显示名：空、null、全空格都显示「未记录」。 */
export function creatorLabel(name: string | null | undefined): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed || CREATOR_UNRECORDED;
}

/** 操作者显示名（出图版本等）：语义是操作者而非生成人，文案同为「未记录」。 */
export function actorLabel(name: string | null | undefined): string {
  return creatorLabel(name);
}

export const REVIEW_COPY = {
  reject: "退回",
  sign: "签字",
  /**
   * 还有待确认时签字左侧提示与签字悬停说明：与服务端 /complete 400 同一句（`completeGate.ts`）。
   * 按词分开数、词序按首次出现、「、」连接；只有一类时如「仍有 2 条待人工确认未处理」，
   * 多类如「仍有 2 条待人工确认、1 条认字存疑未处理」。前后端逐字一致由 `signCopy.contract.test.ts` 锁住。
   */
  pendingUnresolved: (parts: ReadonlyArray<{ word: string; count: number }>) =>
    `仍有 ${parts.map(({ word, count }) => `${count} 条${word}`).join("、")}未处理`,
  /** 拦截文案里「只因认字存疑要结论」的条目填的词（状态本身可能是「一致」）。 */
  readingDoubtWord: "认字存疑",
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
  spot: "对照",
  spotTitle: "对照卡",
  excelStandard: "Excel标准",
  diffFragment: "差异片段",
  notFullSentence: "不是整句标准",
  notFullParagraph: "不是整段",
  oldNoSentence: "旧结果，无整句",
  multiRows: "对上了多行，不拼成一句",
  manuscriptRead: "稿上读到",
  manuscriptFragment: "稿上片段",
  missHere: "漏在这里",
  extraHere: "多在这里",
  missedText: (text: string) => `少了「${text}」`,
  extraText: (text: string) => `多了「${text}」`,
  locusGap: "这里",
  spanDuplicate: "这段里同一片段出现两次，没有标出",
  spanUnmatched: "对不上整句，没有标出",
  backToFrame: "回到框旁",
  cardLeftFrame: "卡已离开框",
  prevItem: "上一项",
  nextItem: "下一项",
  pendingEmptySign: "待确认已空，签字仍在右侧",
  noBox: "没找到位置，请看整页",
  lineNotBoxed: "没框住这一行",
  pageSkew: "这一页方向对不上，框不准",
  phoneDraftSave: "保存备注",
  phoneDraftLoseTitle: "备注未保存，切换后会丢失",
  phoneDraftLoseOk: "丢掉备注",
  phoneDraftLoseCancel: "再看看",
  /** 签字旁勾选；与后端 /complete 400 文案一致。 */
  orderHeldConfirm: "整单待人工确认，签字即认可",
  /** 签字/退回因未存备注灰掉时旁边的原因。 */
  unsavedNotesBlock: "备注未保存，请先保存",
  heldUnread: "认字存疑",
  /** 条目状态不在已知集合：与服务端 /complete 400「审核数据状态异常」对齐。 */
  invalidHitStatus: "审核数据状态异常",
  /** 审稿员可见的认字报错：不露组件名、路径或堆栈。 */
  ocrFailed: "认字出了问题，请联系管理员",
  /** 后端超页（page_over）：只核 1 页。不写「拆分后上传」。 */
  pageOver: "稿件超过 1 页，暂不支持核对，请联系管理员",
  /** 复核失败 / 检查中断但带上一轮条目的三种失败条（老板 2026-10-17 复核失败按 B）：结尾引导重新上传，条里有「重新上传这一单」按钮。 */
  reworkFailed: "复核出了问题，下面是上一轮的结果，可以重新上传这一单",
  compareFailedWithHits: "检查中断了，下面是上一轮的结果，可以重新上传这一单",
  reworkPageOver: "稿件超过 1 页，这次复核没做，下面是上一轮的结果，可以重新上传这一单",
  heldNote: "备注没对上",
  excelMissing: "确认单没有这段",
  spaceLabel: "空格",
} as const;
