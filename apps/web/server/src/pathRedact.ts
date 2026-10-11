import { DATA_DIR, PYTHON } from "./config.js";
import { blenderBin, illustratorBin, pythonBin } from "./settings.js";

// 给非管理员和飞书看的报错：去掉本机目录，只留文件名；没有文件名的目录写成「本机路径」。
const STOP = String.raw`\s"'<>|,，。;；）)\]`;
const WIN_PATH = new RegExp(String.raw`[A-Za-z]:[\\/][^${STOP}]*`, "g");
const UNC_PATH = new RegExp(String.raw`\\\\[^${STOP}]+`, "g");
const UNIX_PATH = new RegExp(String.raw`(^|[\s=:：("'（\[])(\/(?:[^${STOP}/]+\/)+[^${STOP}/]*)`, "g");
const LOCAL_PLACEHOLDER = "本机路径";

function leafOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const leaf = parts[parts.length - 1] || "";
  return /\.[A-Za-z0-9]{1,8}$/.test(leaf) && !/^[A-Za-z]:$/.test(leaf) ? leaf : LOCAL_PLACEHOLDER;
}

function knownLocalPaths(): string[] {
  const out = new Set<string>();
  for (const get of [() => DATA_DIR, () => PYTHON, pythonBin, blenderBin, illustratorBin]) {
    try {
      const p = String(get() || "").trim();
      if (p.length >= 3 && /[\\/]/.test(p)) out.add(p);
    } catch {
      /* 读不到配置就只靠通用规则 */
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactLocalPaths(message: string | undefined | null): string {
  let s = String(message ?? "");
  if (!s) return s;
  // 先处理已知目录（可能含空格，如 C:\Program Files\...），目录本身换占位，其下文件交给通用规则留文件名。
  for (const known of knownLocalPaths()) {
    if (!s.includes(known)) continue;
    const leaf = leafOf(known);
    s = s.split(known).join(leaf === LOCAL_PLACEHOLDER ? `${LOCAL_PLACEHOLDER}` : leaf);
  }
  s = s.replace(/本机路径([\\/][^\s"'<>|,，。;；）)\]]*)/g, (_m, rest: string) => leafOf(rest));
  s = s.replace(WIN_PATH, (m) => leafOf(m));
  s = s.replace(UNC_PATH, (m) => leafOf(m));
  s = s.replace(UNIX_PATH, (_m, pre: string, p: string) => `${pre}${leafOf(p)}`);
  return s;
}
