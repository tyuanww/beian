import type { ProbeResult } from "../api";

export const SETUP_RETURN = "wb_setup_return_probe";
export const SETUP_NEXT = "/settings?group=" + encodeURIComponent("开工板");

export const PROBE_BY_GROUP: Record<string, string[]> = {
  开工板: ["feishu", "lark", "baidu", "minimax", "python", "blender", "illustrator"],
  飞书登录: ["feishu"],
  飞书推送: ["lark"],
  "百度 OCR": ["baidu"],
  "MiniMax（可选）": ["minimax"],
  本机依赖: ["python", "blender", "illustrator"],
};

export const VIRTUAL = new Set(["外观", "开工板", "费用账单"]);

export const BOARD_ROWS: {
  id: string;
  title: string;
  group: string;
  kind: "wizard" | "push" | "scan" | "retry";
}[] = [
  { id: "feishu", title: "登录设置", group: "飞书登录", kind: "wizard" },
  { id: "lark", title: "消息通知", group: "飞书推送", kind: "push" },
  { id: "baidu", title: "文字识别", group: "百度 OCR", kind: "wizard" },
  { id: "minimax", title: "AI 复核", group: "MiniMax（可选）", kind: "wizard" },
  { id: "python", title: "Python", group: "本机依赖", kind: "retry" },
  { id: "blender", title: "Blender", group: "本机依赖", kind: "scan" },
  { id: "illustrator", title: "Illustrator", group: "本机依赖", kind: "scan" },
];

export type WizardGuide = {
  intro: string;
  steps: string[];
};

export const WIZARD: Record<string, WizardGuide> = {
  飞书登录: {
    intro: "连接飞书账号。",
    steps: [
      "填写飞书应用信息。",
      "填写回调地址。",
      "保存后点击飞书登录完成授权。",
    ],
  },
  飞书推送: {
    intro: "向当前账号发送一条测试消息。",
    steps: [
      "没有登录时，先完成飞书授权。",
      "点击发送测试。",
      "在飞书中确认是否收到消息。",
    ],
  },
  "百度 OCR": {
    intro: "设置图片文字识别。",
    steps: [
      "填写文字识别服务密钥。",
      "保存设置。",
      "回到运行状态重新检查。",
    ],
  },
  "MiniMax（可选）": {
    intro: "设置 AI 复核。",
    steps: [
      "填写服务密钥。",
      "选择可用模型。",
      "保存后重新检查。",
    ],
  },
};

export const HOST_INTRO =
  "检查服务器上的运行环境。";

export const PUSH_INTRO =
  "向当前账号发送一条测试消息。";

export function settingsGroupPath(group: string): string {
  return "/settings?group=" + encodeURIComponent(group);
}

export function feishuLoginHref(nextGroup = "开工板"): string {
  return `/api/auth/feishu/login?next=${encodeURIComponent(settingsGroupPath(nextGroup))}`;
}

export function feishuAppReady(
  groups: { fields: { key: string; set: boolean }[] }[] | undefined,
): boolean {
  if (!groups) return false;
  const fields = groups.flatMap((g) => g.fields);
  return Boolean(fields.find((f) => f.key === "FEISHU_APP_ID")?.set && fields.find((f) => f.key === "FEISHU_APP_SECRET")?.set);
}

export function shortGroupLabel(title: string): string {
  const labels: Record<string, string> = {
    外观: "外观",
    开工板: "运行状态",
    费用账单: "费用",
    飞书登录: "登录设置",
    飞书推送: "消息通知",
    "百度 OCR": "文字识别",
    "MiniMax（可选）": "AI 复核",
    本机依赖: "运行环境",
  };
  return labels[title] || title;
}

export function setupHeadline(probes: Record<string, ProbeResult | { pending: true }>): string {
  const rows = BOARD_ROWS.map((row) => probes[row.id]);
  const done = rows.filter((r): r is ProbeResult => Boolean(r) && !("pending" in r));
  const ok = done.filter((r) => r.ok).length;
  if (done.length === 0) return "还没检查。先检查全部。";
  if (ok === BOARD_ROWS.length) return "运行环境正常。";
  const firstBad = firstBadRow(probes);
  return `还有 ${BOARD_ROWS.length - ok} 项待处理。${firstBad ? `下一步：${firstBad.title}` : "请查看状态。"}`;
}

export function firstBadRow(probes: Record<string, ProbeResult | { pending: true }>) {
  return BOARD_ROWS.find((row) => {
    const r = probes[row.id];
    return r && !("pending" in r) && !r.ok;
  });
}

export function statusWord(
  r: ProbeResult | { pending: true } | undefined,
  mode?: "send",
): { cls: string; text: string } {
  if (!r) return { cls: "is-idle", text: "未检查" };
  if ("pending" in r) return { cls: "is-wait", text: mode === "send" ? "发送中" : "检查中" };
  if (r.ok && /未启用/.test(r.message)) return { cls: "is-ok", text: "未启用" };
  if (r.ok) return { cls: "is-ok", text: "正常" };
  if (/超时/.test(r.message)) return { cls: "is-wait", text: "超时" };
  return { cls: "is-bad", text: "待处理" };
}

export function isPending(r: ProbeResult | { pending: true } | undefined): r is { pending: true } {
  return Boolean(r && "pending" in r);
}

export function rowDetail(
  row: (typeof BOARD_ROWS)[number],
  r: ProbeResult | { pending: true } | undefined,
  who: string,
  sending = false,
): string {
  if (sending && row.kind === "push") return "正在发送测试消息。";
  if (isPending(r)) {
    if (row.kind === "scan") return "正在检查运行环境…";
    return "正在检查…";
  }
  if (r) {
    if (row.id === "lark" && r.ok) return `可以发给当前账号 · ${who}`;
    return r.message;
  }
  return idleRowMessage(row.id, row.kind);
}

export function foldCatalogReason(
  group: string,
  fields: { key: string; set: boolean; last4?: string; value?: string }[],
  probe?: ProbeResult | { pending: true },
): string | null {
  const probeOk = Boolean(probe && !("pending" in probe) && probe.ok);
  if (group === "飞书推送") {
    return "接收人会由测试消息自动设置。";
  }
  if (group === "百度 OCR") {
    const ak = fields.find((f) => f.key === "BAIDU_OCR_API_KEY");
    if (ak?.set || probeOk) {
      return "文字识别已可用。密钥已收起。";
    }
  }
  if (group === "MiniMax（可选）") {
    const enabled = fields.find((f) => f.key === "MINIMAX_ENABLED");
    const key = fields.find((f) => f.key === "MINIMAX_API_KEY");
    if (enabled?.value === "false" || (probe && !("pending" in probe) && /未启用/.test(probe.message))) {
      return "AI 复核未启用。密钥已收起。";
    }
    if (key?.set || probeOk) {
      return "AI 复核已可用。密钥已收起。";
    }
  }
  return null;
}

export function progressSpoken(probes: Record<string, ProbeResult | { pending: true }>, probeBusy: string): string {
  if (probeBusy) return probeBusy.replaceAll("检测中", "检查中");
  const done = BOARD_ROWS.map((row) => probes[row.id]).filter(
    (r): r is ProbeResult => Boolean(r) && !("pending" in r),
  );
  const ok = done.filter((r) => r.ok).length;
  if (done.length === 0) return `0 / ${BOARD_ROWS.length} 未检查，先检查全部`;
  const firstBad = firstBadRow(probes);
  if (ok === BOARD_ROWS.length) return `${BOARD_ROWS.length} / ${BOARD_ROWS.length} 正常`;
  if (firstBad) return `${ok} / ${BOARD_ROWS.length} 正常，下一步 ${firstBad.title}`;
  return `${ok} / ${BOARD_ROWS.length} 正常`;
}

export function idleRowMessage(id: string, kind: (typeof BOARD_ROWS)[number]["kind"]): string {
  if (id === "minimax") return "检查可用模型。";
  if (kind === "scan") return "请先检查运行环境。";
  if (kind === "push") return "点击发送测试。";
  return "点击检查。";
}

export function probeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : "探测失败";
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "服务没连上，请稍后重试。";
  }
  return raw;
}
