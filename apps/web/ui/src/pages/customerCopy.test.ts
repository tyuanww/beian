import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customerCopy } from "./customerCopy.js";

describe("customerCopy", () => {
  it("names the two review passes 检查 / 复核 for users", () => {
    assert.equal(customerCopy("对照失败"), "检查失败");
    assert.equal(customerCopy("对红中"), "复核中");
    assert.equal(customerCopy("对照阶段超时"), "检查阶段超时");
    assert.equal(customerCopy("对红结果已保存"), "复核结果已保存");
  });

  it("keeps the existing 已签字 → 已提交 wording", () => {
    assert.equal(customerCopy("已签字"), "已提交");
  });

  it("rewrites native-text jargon and drops a home-directory path", () => {
    assert.equal(customerCopy("两种文字来源无法唯一对应，请对照稿面。"), "两种读法对不上，请看稿面");
    assert.equal(customerCopy("原稿文字已直接参与核对规则。"), "原稿文字已经参与核对");
    assert.equal(customerCopy("稿件未保留 Illustrator 编辑数据"), "稿件未保留 编辑数据");
    assert.equal(customerCopy("失败 /Users/reviewer/job/art.pdf 读不到"), "失败 读不到");
    assert.equal(customerCopy("打样单 D:\\a b\\c 露出来了"), "打样单 露出来了");
    assert.equal(customerCopy("失败 /Users/a b/c 读不到"), "失败 读不到");
    assert.equal(customerCopy("找不到文件 D:\\备案稿\\客户新品.ai"), "找不到文件");
    assert.equal(customerCopy("读取 D:\\客户 张三\\报价.pdf 失败"), "读取 失败");
    assert.equal(customerCopy("失败 /Users/a/b.pdf 30ml，请核对"), "失败 30ml，请核对");
    assert.equal(customerCopy("找不到文件 D:\\稿。\\Users\\hutou\\secret.pdf"), "找不到文件");
    assert.equal(customerCopy("路径 C:\\稿件\\文件.pdf\u3000请核对净含量"), "路径 请核对净含量");
    assert.equal(customerCopy("失败 D:\\a\\b.pdf。请核对"), "失败。请核对");
    assert.equal(customerCopy("失败 D:\\a\\b.pdf 见附件.pdf 请核对"), "失败 见附件.pdf 请核对");
    assert.equal(customerCopy("读取 /Users/a/file.pdf 30ml.pdf，请核对"), "读取 30ml.pdf，请核对");
    assert.equal(customerCopy("失败 D:/稿件/a.pdf 请核对"), "失败 请核对");
    assert.equal(customerCopy("打开 http://example.com/a.pdf 请核对"), "打开 http://example.com/a.pdf 请核对");
    assert.equal(customerCopy("见 https://jianghua.site/r/1 请核对"), "见 https://jianghua.site/r/1 请核对");
    assert.equal(customerCopy("失败 \\\\server\\share\\a.pdf 请核对"), "失败 请核对");
    assert.equal(customerCopy("净含量 C:\\见包装，请核对"), "净含量，请核对");
    assert.equal(customerCopy("FSC、认证码、星级已跳过，不进退稿"), "森林认证、认证码和星级先跳过，不写进退稿");
  });
});
