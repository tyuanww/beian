import { customerCopy } from "./customerCopy";

/** 生成失败给人看。不要把路径和实现名塞进看板。 */

export function mockupFailTag(): string {
  return "生成中断";
}

export function mockupFailReason(raw?: string | null): string {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t) return "生成中断，请打开查看。";
  if (/没有刀线或刀版/.test(t)) {
    return "没找到刀线，请保留后重传";
  }
  if (/刀线读不出结构/.test(t)) {
    return "刀线无法折成盒面。请检查展开图。";
  }
  if (/画板尺寸与模板不符/.test(t)) {
    return "刀线没有对上结构。请整理刀线后再上传。";
  }
  if (/Node不存在|演示文稿运行时/.test(t)) {
    return "演示稿暂不可用，白底和模型仍可下载。";
  }
  return (customerCopy(t) || "生成中断").slice(0, 80);
}
