import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProbeResult } from "../api";
import {
  BOARD_ROWS,
  WIZARD,
  feishuAppReady,
  feishuLoginHref,
  foldCatalogReason,
  idleRowMessage,
  probeErrorMessage,
  progressSpoken,
  rowDetail,
  settingsGroupPath,
  setupHeadline,
  shortGroupLabel,
  statusWord,
} from "./setupBoard.js";

describe("setupBoard copy", () => {
  it("has seven rows and short idle copy", () => {
    assert.equal(BOARD_ROWS.length, 7);
    assert.equal(
      BOARD_ROWS.some((row) => row.title === "通" || row.title === "不通"),
      false,
    );
    assert.match(idleRowMessage("minimax", "wizard"), /检查可用模型/);
    assert.doesNotMatch(idleRowMessage("minimax", "wizard"), /\/v1\/models|^通$|^不通$/);
    assert.match(idleRowMessage("blender", "scan"), /运行环境/);
    assert.match(idleRowMessage("lark", "push"), /发送测试/);
  });

  it("wizard pages stay three short steps", () => {
    assert.equal(WIZARD["飞书登录"].steps.length, 3);
    assert.equal(WIZARD["飞书推送"].steps.length, 3);
    assert.match(WIZARD["飞书推送"].intro, /测试消息/);
    assert.doesNotMatch(WIZARD["飞书推送"].intro, /lark-cli|open_id/);
    assert.equal(WIZARD["百度 OCR"].steps.length, 3);
    assert.equal(WIZARD["MiniMax（可选）"].steps.length, 3);
    assert.match(WIZARD["飞书登录"].steps[1], /回调地址/);
    assert.doesNotMatch(WIZARD["飞书登录"].steps.join(""), /\/api\//);
    assert.match(WIZARD["百度 OCR"].intro, /文字识别/);
    assert.doesNotMatch(`${WIZARD["百度 OCR"].intro} ${WIZARD["百度 OCR"].steps.join(" ")}`, /对照|静默授权|OCR/);
    const mini = `${WIZARD["MiniMax（可选）"].intro} ${WIZARD["MiniMax（可选）"].steps.join(" ")}`;
    assert.match(mini, /AI 复核|服务密钥|可用模型/);
    assert.doesNotMatch(mini, /GET \/v1\/models|MiniMax/);
  });

  it("status words stay short and never say 通 or 不通", () => {
    assert.deepEqual(statusWord(undefined), { cls: "is-idle", text: "未检查" });
    assert.deepEqual(statusWord({ pending: true }), { cls: "is-wait", text: "检查中" });
    assert.deepEqual(statusWord({ pending: true }, "send"), { cls: "is-wait", text: "发送中" });
    assert.equal(statusWord({ id: "x", ok: true, message: "模型列表已返回" }).text, "正常");
    assert.equal(statusWord({ id: "minimax", ok: true, message: "未启用（不影响主流程）" }).text, "未开启");
    assert.equal(statusWord({ id: "x", ok: false, message: "Key 无效" }).text, "需处理");
    assert.equal(statusWord({ id: "x", ok: false, message: "12 秒超时" }).text, "超时");
    assert.notEqual(statusWord({ id: "x", ok: false, message: "不通" }).text, "不通");
  });

  it("full headline stays a status line", () => {
    const ok: ProbeResult = { id: "feishu", ok: true, message: "网页应用能走完授权" };
    const probes = Object.fromEntries(BOARD_ROWS.map((row) => [row.id, { ...ok, id: row.id }]));
    const line = setupHeadline(probes);
    assert.match(line, /运行环境正常/);
    assert.doesNotMatch(line, /可以接稿|8\/31/);
    assert.equal(progressSpoken(probes, ""), "7 / 7 正常");
  });

  it("progress spoken names the next row by its display title", () => {
    const probes = {
      feishu: { id: "feishu", ok: true, message: "ok" },
      lark: { id: "lark", ok: true, message: "ok" },
      baidu: { id: "baidu", ok: false, message: "还没填" },
    };
    assert.match(progressSpoken(probes, ""), /下一步 文字识别/);
    assert.match(setupHeadline(probes), /还有 5 项待处理/);
    assert.match(progressSpoken({}, "检查中 3/7"), /检查中 3\/7/);
  });

  it("probe errors stay short", () => {
    assert.equal(probeErrorMessage(new Error("Failed to fetch")), "服务没连上，请稍后重试。");
    assert.equal(probeErrorMessage(new Error("Key 无效")), "Key 无效");
    assert.doesNotMatch(probeErrorMessage(new Error("Failed to fetch")), /8787/);
  });

  it("narrow pills keep internal keys and shorten labels", () => {
    assert.equal(shortGroupLabel("外观"), "外观");
    assert.equal(shortGroupLabel("开工板"), "系统状态");
    assert.equal(shortGroupLabel("费用账单"), "费用");
    assert.equal(shortGroupLabel("飞书登录"), "飞书登录");
    assert.equal(shortGroupLabel("飞书推送"), "飞书通知");
    assert.equal(shortGroupLabel("百度 OCR"), "文字识别");
    assert.equal(shortGroupLabel("MiniMax（可选）"), "AI 复核");
    assert.equal(shortGroupLabel("本机依赖"), "本机软件");
  });

  it("folds filled secret groups without exposing keys", () => {
    const baidu = foldCatalogReason(
      "百度 OCR",
      [{ key: "BAIDU_OCR_API_KEY", set: true, last4: "…abcd", value: "" }],
      { id: "baidu", ok: true, message: "文字识别可用" },
    );
    assert.match(String(baidu), /密钥已收起/);
    assert.doesNotMatch(String(baidu), /abcd/);
    const mini = foldCatalogReason(
      "MiniMax（可选）",
      [{ key: "MINIMAX_ENABLED", set: true, last4: "", value: "false" }],
      { id: "minimax", ok: true, message: "未启用" },
    );
    assert.match(String(mini), /未开启/);
    const push = foldCatalogReason("飞书推送", [], undefined);
    assert.match(String(push), /测试消息/);
    assert.equal(
      foldCatalogReason("百度 OCR", [{ key: "BAIDU_OCR_API_KEY", set: false, last4: "", value: "" }], undefined),
      null,
    );
  });

  it("send-in-progress copy stays 发送中", () => {
    const row = BOARD_ROWS.find((r) => r.id === "lark");
    assert.ok(row);
    assert.match(rowDetail(row, { pending: true }, "天元（魏炜）", true), /正在发送测试消息/);
    assert.doesNotMatch(idleRowMessage("lark", "push"), /open_id/);
    assert.equal(settingsGroupPath("飞书推送"), "/settings?group=" + encodeURIComponent("飞书推送"));
    assert.match(feishuLoginHref("飞书推送"), /^\/api\/auth\/feishu\/login\?next=/);
    assert.equal(feishuAppReady(undefined), false);
    assert.equal(
      feishuAppReady([
        {
          fields: [
            { key: "FEISHU_APP_ID", set: true },
            { key: "FEISHU_APP_SECRET", set: true },
          ],
        },
      ]),
      true,
    );
  });
});
