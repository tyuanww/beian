import { DATA_DIR, PYTHON } from "./config.js";
import { blenderBin, illustratorBin, pythonBin } from "./settings.js";

/**
 * 给非管理员和飞书看的报错：去掉本机目录，只留文件名；没有文件名的目录写成「本机路径」。
 *
 * 先把 URL 编码的分隔符 `%5C` / `%2F` 还原。手写的线性扫描器（不用回溯正则，避免 ReDoS）。规则：
 * - 路径起点：Windows 盘符 `X:\` / `X:/`；UNC `\\`（含 `\\?\`）；Unix 绝对路径 `/`（前一个字符不是 ASCII 字母数字或 `. _ - ~ / \`，
 *   所以紧贴中文也算起点，相对路径 `docs/x.md` 不算）。Unix 路径至少要有一级目录（`/tmp` 原样保留）。
 * - 路径在空白、引号、括号、逗号分号等中英文标点处结束；Windows / UNC 目录名中的空格见 scanPath。
 * - 末段带 1–8 位 ASCII 扩展名的当作文件名保留；扩展名后紧跟非 ASCII 字符（如「失败」）时，文件名到扩展名为止。
 *   末段没有扩展名时整段换成「本机路径」；末段是「ASCII 开头 + 中文结尾」时中文部分视为后文保留。
 * - 替换结果与前后紧贴的中文之间补一个空格（已有空格或标点则不补）。
 */
const LOCAL_PLACEHOLDER = "本机路径";
const HARD_STOP = new Set([..."\"'`<>|,，。;；：、（）()[]【】{}「」！？"]);
const EXT_AT_END = /\.[A-Za-z0-9]{1,8}$/;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "\u3000";
}
function isAsciiWordish(ch: string): boolean {
  return /[A-Za-z0-9._\-~/\\]/.test(ch);
}
function isAsciiLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}
function isSep(ch: string): boolean {
  return ch === "/" || ch === "\\";
}
function isStop(ch: string): boolean {
  return isSpace(ch) || HARD_STOP.has(ch);
}
/** 中文等非 ASCII 正文字符（不含空白和标点），替换结果与它相邻时补空格。 */
function isCjkText(ch: string | undefined): boolean {
  return Boolean(ch) && ch!.charCodeAt(0) > 0x7f && !isSpace(ch!) && !HARD_STOP.has(ch!);
}

/** i 处是否是路径起点；返回起点之后扫描开始的位置，不是起点返回 -1。 */
function pathStart(s: string, i: number): number {
  const ch = s[i];
  const prev = i > 0 ? s[i - 1] : "";
  if (ch === "\\" && s[i + 1] === "\\" && prev !== "\\") return i + 2;
  if (isAsciiLetter(ch) && s[i + 1] === ":" && isSep(s[i + 2] || "")) return i + 3;
  if (ch === "/" && !(prev && isAsciiWordish(prev))) return i + 1;
  return -1;
}

/**
 * 从起点扫描路径结束位置，返回 [结束位置, 最后一个分隔符位置]。
 * Windows / UNC 路径的目录名可含空格：遇到空格时向后看下一个词，只有它在碰到空白、标点或新路径起点之前
 * 出现分隔符，才把空格当作目录名的一部分继续；否则路径在空格处结束。Unix 路径遇空格即结束。
 * 每个字符最多被扫描两次（一次预读、一次正式），整体线性。
 */
function scanPath(s: string, from: number, allowSpaces: boolean): [number, number] {
  let j = from;
  let lastSep = from - 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === " " && allowSpaces && continuesAcrossSpace(s, j + 1)) {
      j += 1;
      continue;
    }
    if (isStop(ch)) break;
    if (isSep(ch)) lastSep = j;
    j += 1;
  }
  return [j, lastSep];
}

function continuesAcrossSpace(s: string, k: number): boolean {
  if (k >= s.length || pathStart(s, k) >= 0) return false;
  for (let m = k; m < s.length; m += 1) {
    const ch = s[m];
    if (isStop(ch)) return false;
    if (isSep(ch)) return m > k;
    if (m > k && pathStart(s, m) >= 0) return false;
  }
  return false;
}

/** 末段渲染：返回 [替换文本, 留给后文的部分]。 */
function renderLeaf(leaf: string): [string, string] {
  let name = leaf;
  let rest = "";
  // 扩展名后紧跟非 ASCII：文件名到扩展名为止。
  for (let k = 0; k < leaf.length; k += 1) {
    if (leaf.charCodeAt(k) > 0x7f) {
      const head = leaf.slice(0, k);
      if (EXT_AT_END.test(head) || (/^[\x00-\x7f]+$/.test(head) && head.length > 0)) {
        name = head;
        rest = leaf.slice(k);
      }
      break;
    }
  }
  // 句末标点（如 `a.pdf.`、`a.pdf:`）留给后文。
  const trail = /[.:!?]+$/.exec(name);
  if (trail) {
    const base = name.slice(0, -trail[0].length);
    if (EXT_AT_END.test(base) || !EXT_AT_END.test(name)) {
      name = base;
      rest = trail[0] + rest;
    }
  }
  return [EXT_AT_END.test(name) ? name : LOCAL_PLACEHOLDER, rest];
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

function scanAndRedact(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const from = pathStart(s, i);
    if (from < 0) {
      out += s[i];
      i += 1;
      continue;
    }
    const isUnix = s[i] === "/";
    const [end, lastSep] = scanPath(s, from, !isUnix);
    if (isUnix && lastSep <= i) {
      out += s[i];
      i += 1;
      continue;
    }
    const [text, rest] = renderLeaf(s.slice(lastSep + 1, end));
    if (isCjkText(out[out.length - 1])) out += " ";
    out += text;
    const after = rest || s[end];
    if (isCjkText(after?.[0])) out += " ";
    out += rest;
    i = end;
  }
  return out;
}

export function redactLocalPaths(message: string | undefined | null): string {
  let s = String(message ?? "");
  if (!s) return s;
  // URL 编码的分隔符（%5C、%2F，大小写不限）先还原，再按普通路径处理。
  s = s.replace(/%5c/gi, "\\").replace(/%2f/gi, "/");
  // 先处理已知目录（可能含空格，如 C:\Program Files\...）：整段是文件就换成文件名，是目录就换占位，其下文件再留文件名。
  for (const known of knownLocalPaths()) {
    if (!s.includes(known)) continue;
    const [leaf] = renderLeaf(known.split(/[\\/]+/).filter(Boolean).pop() || "");
    s = s.split(known).join(leaf === LOCAL_PLACEHOLDER ? `\u0000${LOCAL_PLACEHOLDER}` : leaf);
  }
  // 占位后紧跟的子路径只留文件名。
  s = s.replace(/\u0000本机路径((?:[\\/][^\s"'<>|,，。;；）)\]\u0000]*)?)/g, (_m, sub: string) => {
    if (!sub) return LOCAL_PLACEHOLDER;
    const parts = sub.split(/[\\/]+/);
    return renderLeaf(parts[parts.length - 1] || "")[0];
  });
  return scanAndRedact(s);
}
