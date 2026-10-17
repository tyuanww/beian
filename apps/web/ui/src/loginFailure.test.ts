import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feishuErrorCode, loginFailure } from "./loginFailure.js";

describe("loginFailure 按 feishu_error 码定标题", () => {
  it("denied：授权未完成", () => {
    assert.deepEqual(loginFailure("denied", "已取消飞书授权。"), {
      code: "denied",
      title: "授权未完成",
      message: "已取消飞书授权。",
    });
  });

  it("expired：登录已过期", () => {
    assert.equal(loginFailure("expired", "登录已过期，请再点一次飞书登录。").title, "登录已过期");
  });

  it("forbidden：非伸美企业进不了", () => {
    assert.equal(loginFailure("forbidden", "只允许伸美公司的飞书号进入。").title, "进不了这间审稿室");
  });

  it("forbidden：账号不在账号目录、已停用、身份无效也进不了（不看原因文案）", () => {
    for (const hint of ["这个飞书号不在账号目录。", "账号已停用，请联系管理员。", "飞书身份无效"]) {
      const f = loginFailure("forbidden", hint);
      assert.equal(f.title, "进不了这间审稿室", hint);
      assert.equal(f.message, hint);
    }
  });

  it("failed：飞书授权未完成，原因里碰巧有「过期 / 取消 / 不允许」也不改标题", () => {
    for (const hint of ["飞书换票失败", "token 已过期", "请求被取消", "不允许的 redirect_uri", "账号目录中有重复 open_id，请联系管理员。"]) {
      assert.equal(loginFailure("failed", hint).title, "飞书授权未完成", hint);
    }
  });

  it("原因 cookie 没了就用该码的兜底原因", () => {
    assert.equal(loginFailure("denied", "").message, "已取消飞书授权。");
    assert.equal(loginFailure("expired", "").message, "登录已过期，请再点一次。");
    assert.equal(loginFailure("forbidden", "").message, "只允许伸美公司的飞书号进入。");
    assert.equal(loginFailure("failed", "").message, "飞书授权失败，请再试一次。");
  });

  it("未知码：飞书授权未完成，原因里有「伸美」也不当 forbidden", () => {
    const f = loginFailure("teapot", "只允许伸美公司的飞书号进入。");
    assert.deepEqual(f, { code: null, title: "飞书授权未完成", message: "只允许伸美公司的飞书号进入。" });
    assert.equal(loginFailure("teapot", "").message, "飞书授权未完成。");
  });

  it("没有码：飞书授权未完成", () => {
    for (const raw of ["", null, undefined]) {
      assert.deepEqual(loginFailure(raw, ""), { code: null, title: "飞书授权未完成", message: "飞书授权未完成。" });
    }
  });

  it("原型链上的名字不算码，大小写不同也不算", () => {
    for (const raw of ["toString", "constructor", "__proto__", "hasOwnProperty", "Forbidden", " denied"]) {
      assert.equal(feishuErrorCode(raw), null, raw);
      assert.equal(loginFailure(raw, "").title, "飞书授权未完成", raw);
    }
  });
});
