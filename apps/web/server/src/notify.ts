import { spawn } from "node:child_process";
import { whichLark } from "./larkBin.js";
import { httpsJson } from "./outbound.js";
import { getSetting, publicBase } from "./settings.js";

type TaskLike = {
  id?: string;
  title?: string;
  conclusion?: string;
  complete_kind?: string;
  verbatim_check?: boolean;
  hits?: Array<{ field?: string; status?: string; decision?: string; page?: number | string }>;
  hits_v2?: Array<{ field?: string; status?: string; decision?: string; page?: number | string }>;
};

function selectedHits(task: TaskLike): NonNullable<TaskLike["hits"]> {
  if (task.verbatim_check === true) {
    if (Array.isArray(task.hits_v2)) return task.hits_v2;
    return Array.isArray(task.hits) ? task.hits : [];
  }
  if (Array.isArray(task.hits_v2) && task.hits_v2.length > 0) return task.hits_v2;
  return task.hits || [];
}

function clipText(text: string): string {
  return text.length <= 3500 ? text : `${text.slice(0, 3400)}\n…(截断)`;
}

function feishuErr(json: unknown): string {
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const err = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : {};
  const msg = String(err.message || o.msg || o.message || "").trim();
  const code = err.code ?? o.code;
  if (/scope|99991679|99991663/i.test(`${code} ${msg}`)) {
    return "飞书应用还没开通发消息权限。去开放平台给这应用加 IM，再让对方先跟机器人说过一句话。";
  }
  return msg ? `飞书返回：${msg}`.slice(0, 200) : "用飞书应用发消息失败";
}

async function sendViaApp(
  openId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const appId = getSetting("FEISHU_APP_ID").trim();
  const secret = getSetting("FEISHU_APP_SECRET").trim();
  if (!appId || !secret) return { ok: false, reason: "还没填飞书 App ID 或 Secret" };
  let token = "";
  try {
    const tok = await httpsJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: secret }),
    });
    const body = (tok.json || {}) as { code?: number; tenant_access_token?: string; msg?: string };
    if (body.code !== 0 || !body.tenant_access_token) {
      return { ok: false, reason: feishuErr(tok.json) };
    }
    token = body.tenant_access_token;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "连不上飞书拿 token" };
  }
  try {
    const sent = await httpsJson("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
      timeoutMs: 20_000,
    });
    const body = (sent.json || {}) as { code?: number; msg?: string };
    if (sent.status >= 200 && sent.status < 300 && (body.code === 0 || body.code === undefined)) {
      return { ok: true };
    }
    return { ok: false, reason: feishuErr(sent.json) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "连不上飞书发消息" };
  }
}

function sendViaCli(
  bin: string,
  openId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const asWho = getSetting("FEISHU_AS") || "bot";
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ["im", "+messages-send", "--as", asWho, "--user-id", openId, "--text", text, "--json"],
      {
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
        timeout: 45_000,
      },
    );
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.on("error", (err) => resolve({ ok: false, reason: err.message }));
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const payload = JSON.parse(stdout) as { ok?: boolean };
          if (payload.ok === false) {
            resolve({ ok: false, reason: "lark-cli 返回失败" });
            return;
          }
        } catch {
          /* 非 JSON 也算发出去了 */
        }
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, reason: `lark-cli exit ${code}` });
    });
  });
}

export type TextSendOptions = { force?: boolean };

export type NotifyTransports = {
  findCli: () => string | null;
  sendCli: typeof sendViaCli;
  sendApp: typeof sendViaApp;
};

/**
 * 传输选择是一条深边界：生产接真实 CLI/飞书，L0 注入假传输，避免测试环境
 * 恰好装了 lark-cli 或带凭证时把合成消息发出去。
 */
export function createTextSender(transports: NotifyTransports) {
  return async function sendTextWithTransports(
    text: string,
    to?: string,
    opts: TextSendOptions = {},
  ): Promise<{ ok: boolean; skipped?: boolean; reason?: string; via?: "cli" | "app" }> {
    if (!opts.force && !/^(1|true|yes|on)$/i.test(getSetting("FEISHU_ENABLED"))) {
      return { ok: false, skipped: true, reason: "FEISHU_ENABLED=false" };
    }
    const openId = (to || getSetting("FEISHU_OPEN_ID") || "").trim();
    if (!openId) return { ok: false, skipped: true, reason: "missing FEISHU_OPEN_ID" };
    const body = clipText(text);
    const bin = transports.findCli();
    if (bin) {
      const cli = await transports.sendCli(bin, openId, body);
      if (cli.ok) return { ok: true, via: "cli" };
      const app = await transports.sendApp(openId, body);
      if (app.ok) return { ok: true, via: "app" };
      return { ok: false, reason: cli.reason || app.reason };
    }
    const app = await transports.sendApp(openId, body);
    if (app.ok) return { ok: true, via: "app" };
    return { ok: false, reason: app.reason || "本机没有 lark-cli，用飞书应用发也失败了" };
  };
}

const productionTextSender = createTextSender({
  findCli: whichLark,
  sendCli: sendViaCli,
  sendApp: sendViaApp,
});

export function sendText(
  text: string,
  to?: string,
  opts: TextSendOptions = {},
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; via?: "cli" | "app" }> {
  // 所有 L0 都共享这条生产出口；在这里失败关闭，避免任一 HTTP 测试因本机
  // 恰好存在飞书配置而把合成审核消息发给真人。
  if (process.env.VITEST === "1") {
    return Promise.resolve({ ok: false, skipped: true, reason: "test notifications disabled" });
  }
  return productionTextSender(text, to, opts);
}

/** 飞书标题按 complete_kind：signed→已签字，rework→已退回；旧任务没有 complete_kind 时按是否有改稿项推断。 */
export function taskCompleteHeadline(task: TaskLike): "已签字" | "已退回" {
  if (task.complete_kind === "rework") return "已退回";
  if (task.complete_kind === "signed") return "已签字";
  return selectedHits(task).some((h) => h.decision === "issue") ? "已退回" : "已签字";
}

export function taskCompleteText(task: TaskLike, actor: string): string {
  const issues = selectedHits(task).filter((h) => h.decision === "issue");
  const headline = taskCompleteHeadline(task);
  const lines = task.verbatim_check === true
    ? issues.slice(0, 12).map((h) => `· ${h.status || "类型"} 第${h.page || "?"}页`)
    : issues.slice(0, 12).map((h) => `· ${h.field || "字段"}`);
  const more = issues.length > 12 ? `\n…另有 ${issues.length - 12} 条` : "";
  return [
    `【备案审核】${headline}`,
    `任务：${task.title || task.id || ""}`,
    `审核人：${actor}`,
    task.verbatim_check === true ? "结论已记下" : `结论：${task.conclusion || "—"}`,
    issues.length ? `改稿 ${issues.length} 条` : "无改稿项",
    ...lines,
    more,
    `打开：${publicBase()}/`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function notifyTaskComplete(task: TaskLike, actor: string): Promise<void> {
  const text = taskCompleteText(task, actor);
  const r = await sendText(text);
  if (!r.ok && !r.skipped) {
    console.warn("feishu notify skipped:", r.reason);
  }
}

export type WatchdogEvent = "save_timeout" | "save_source_changed" | "watchdog_restart_cap";
const WATCHDOG_EVENTS = new Set<string>(["save_timeout", "save_source_changed", "watchdog_restart_cap"]);

/** Illustrator worker 的 stdout 末行是无路径的公开 JSON；只取看门狗 reason。 */
export function watchdogEventFromStdout(stdout: string): WatchdogEvent | undefined {
  const line = stdout.trim().split("\n").pop() || "";
  try {
    const reason = (JSON.parse(line) as { reason?: unknown }).reason;
    return typeof reason === "string" && WATCHDOG_EVENTS.has(reason) ? (reason as WatchdogEvent) : undefined;
  } catch { return undefined; }
}

const WATCHDOG_COPY: Record<WatchdogEvent, { title: string; detail: Record<"compare" | "mockup", string> }> = {
  save_timeout: {
    title: "Illustrator 保存卡住，已自动结束并重启",
    detail: { compare: "原稿文字提取改为图像识别继续核对；请留意杭州机 Illustrator 状态。", mockup: "净版展开本次未完成，可稍后重试；请留意杭州机 Illustrator 状态。" },
  },
  save_source_changed: {
    title: "Illustrator 保存卡住，原稿可能被改动",
    detail: { compare: "已结束卡住的 Illustrator，但原稿 hash 与任务开始时不一致：本次不回退图像识别，已暂停等待人工核实原稿。", mockup: "已结束卡住的 Illustrator，但原稿 hash 与任务开始时不一致：净版已暂停等待人工核实原稿。" },
  },
  watchdog_restart_cap: {
    title: "Illustrator 1 小时内已自动重启 2 次，已停止自动处理",
    detail: { compare: "Illustrator Agent 已进入故障保护，需人工登录杭州机检查（登录/授权弹窗、插件、打印机）后由管理员恢复。", mockup: "Illustrator Agent 已进入故障保护，需人工登录杭州机检查（登录/授权弹窗、插件、打印机）后由管理员恢复。" },
  },
};

/** 看门狗告警；不含路径、PID 或 hash 值。 */
export function illustratorWatchdogText(task: TaskLike, event: WatchdogEvent = "save_timeout", kind: "compare" | "mockup" = "compare"): string {
  const copy = WATCHDOG_COPY[event];
  return [
    `【备案审核】${copy.title}`,
    `任务：${task.title || task.id || ""}`,
    copy.detail[kind],
    task.id ? `打开：${publicBase()}${jobOpenPath(kind, task.id)}` : "",
  ].filter(Boolean).join("\n");
}

export async function notifyIllustratorWatchdog(task: TaskLike, event: WatchdogEvent = "save_timeout", kind: "compare" | "mockup" = "compare"): Promise<void> {
  const r = await sendText(illustratorWatchdogText(task, event, kind));
  if (!r.ok && !r.skipped) console.warn("feishu watchdog notify failed:", r.reason);
}

export function jobOpenPath(kind: "compare" | "rework" | "mockup", tid: string): string {
  return kind === "mockup" ? `/mockup/${tid}` : `/review/${tid}`;
}

export async function notifyJobFinished(opts: {
  tid: string;
  title: string;
  kind: "compare" | "rework" | "mockup";
  ok: boolean;
  error?: string;
}): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  const verb = opts.kind === "mockup" ? "打样" : opts.kind === "rework" ? "对红" : "对照";
  const name = opts.title || opts.tid;
  const link = `${publicBase()}${jobOpenPath(opts.kind, opts.tid)}`;
  const text = opts.ok
    ? opts.kind === "mockup"
      ? `${name} 打样完了，来看产物。\n打开：${link}`
      : `${name} ${verb}完了，来签字。\n打开：${link}`
    : `${name} ${verb}失败：${opts.error || "对照中断"}\n打开：${link}`;
  return sendText(text);
}
