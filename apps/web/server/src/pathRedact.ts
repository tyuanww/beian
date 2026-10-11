import { DATA_DIR, PYTHON } from "./config.js";
import { blenderBin, illustratorBin, pythonBin } from "./settings.js";

/**
 * 给非管理员和飞书看的报错：去掉本机目录，只留文件名；没有文件名的目录写成「本机路径」。
 *
 * 处理顺序（见 redactLocalPaths）：① 整条报错先还原 URL 编码的分隔符 `%5C` / `%2F`（包括网址里的），套了 `%25` 的
 * 多重编码（`%252F`、`%25252F`）循环剥层，到不变为止，最多 3 层；② 还原后超过 8000 字符只取前 8000 字符（截断点落在
 * 代理对中间时少取一位），末尾追加「（后面省略）」；③ 对截下的文本脱敏。
 * 网址：只有 `http://`、`https://`（大小写不限）算网址，逐字扫描。用户名 / 密码（`user:pass@`、`user@`，到主机前最后一个
 * `@`）整段换成 `***@`，主机与端口保留。主机之后遇到夹带的本机路径就整段替换：以 `/` 开头的已配置数据 / 工具目录和
 * `/Users/`、`/home/`、`/root/`、`/var/folders/`、`/private/var/` 换成 `/本机路径`；Windows 写法（盘符 `C:\` / `C:/`、反斜杠
 * 路径、Windows 已配置目录）换成 `本机路径`。夹带路径到 `& # ?`、空白、引号、反引号、尖括号或中文标点为止，中文与 emoji
 * 不算终点；Windows 写法里的空格与网址外同一规则（见 urlPathEnd）。路径之后网址照常继续；网址普通部分到空白、引号、
 * 反引号、尖括号或任何非 ASCII 字符为止。公开网站上含 `/Users/` 等的网址路径也会被替换（宁可误伤）。
 * 其他协议（`x://`、`git+ssh://`、`file://`）按普通路径扫描。
 * 不截断的同一流程导出为 redactLocalPathsUncapped（仅测试用）。网址以外用手写的线性扫描器（不用回溯正则，避免 ReDoS）。规则：
 * - 路径起点：Windows 盘符 `X:\` / `X:/`（前一个字符不能是 ASCII 字母数字，`abc:\x` 不算）；`file://` 前缀先去掉；UNC `\\`（含 `\\?\`）；Unix 绝对路径 `/`（前一个字符不是 ASCII 字母数字或 `. _ - ~ / \`，
 *   所以紧贴中文也算起点，相对路径 `docs/x.md` 不算）；`~/` 与 `~用户名/`；无盘符的反斜杠根路径 `\\Users\\bob\\a.pdf`（至少一级目录；末段不是文件名时要求有一段目录名不少于 2 个字符，`\\n\\t` 不算）。Unix 路径至少要有一级目录（`/tmp` 原样保留）。
 * - 路径在空白、引号、括号、逗号分号等中英文标点处结束；Windows / UNC 目录名与文件名中的空格见 scanPath。
 * - 末段带 1–8 位 ASCII 扩展名的当作文件名保留；扩展名后紧跟非 ASCII 字符（如「失败」）时，文件名到扩展名为止。
 *   堆栈里的 `文件名:行:列` 保留行列号。末段没有扩展名时整段换成「本机路径」；末段是「ASCII 开头 + 中文结尾」时中文部分视为后文保留。
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
  if (isAsciiLetter(ch) && !(prev && /[A-Za-z0-9]/.test(prev)) && s[i + 1] === ":" && isSep(s[i + 2] || "")) return i + 3;
  if (ch === "/" && !(prev && isAsciiWordish(prev))) return i + 1;
  // 无盘符的反斜杠根路径 `\Users\bob\a.pdf`（如 `%5C` 解码而来）；是否脱敏见 scanAndRedact。
  if (ch === "\\" && s[i + 1] !== "\\" && !(prev && isAsciiWordish(prev))) return i + 1;
  // `~/...` 与 `~user/...`：用户名也算目录，不保留。
  if (ch === "~" && !(prev && isAsciiWordish(prev))) {
    let k = i + 1;
    while (k < s.length && /[A-Za-z0-9._-]/.test(s[k])) k += 1;
    if (s[k] === "/") return k + 1;
  }
  return -1;
}

/**
 * 从起点扫描路径结束位置，返回 [结束位置, 最后一个分隔符位置]。
 * Windows / UNC 路径的目录名可含空格：遇到空格先记下「暂定结束位置」继续往后扫；在碰到空白、标点或
 * 新路径起点之前出现分隔符，就确认空格属于目录名；否则路径在暂定位置结束——除非空格前的末段没有扩展名、
 * 空格后的词以扩展名结尾（`a b.pdf`），这时把这个词算进文件名。Unix 路径遇空格即结束。
 * 单趟扫描不回看；回退的那一段最多再被外层逐字扫一次，整体线性。
 */
function scanPath(s: string, from: number, allowSpaces: boolean, leafSpace: boolean): [number, number] {
  return scanRun(s, from, allowSpaces, leafSpace, isStop);
}

/** 中文标点：软终点。之后到下一个空白前若还有分隔符，就当作目录名的一部分继续（`【内部】/a.pdf`、`a，b/c.pdf`）。 */
function isSoftStop(ch: string): boolean {
  return ch.charCodeAt(0) > 0x7f && HARD_STOP.has(ch);
}

/**
 * 路径扫描核心（网址外与网址内共用），单趟、线性。空格（allowSpaces 时）和中文标点是「软终点」：记下最早的暂定结束位置
 * 继续往后扫，在下一个空白 / 硬终点 / 新路径起点之前遇到分隔符就确认续接；否则路径在暂定位置结束。
 * 空格后紧跟分隔符或新路径起点视为另一条路径。leafSpace 时额外允许文件名含一个空格（`a b.pdf`）。
 */
function scanRun(s: string, from: number, allowSpaces: boolean, leafSpace: boolean, hard: (ch: string) => boolean): [number, number] {
  let j = from;
  let lastSep = from - 1;
  let pending = -1;
  let newPath = false;
  // 空格之后第一个中文标点的位置：`a b.pdf，请检查` 判断文件名含空格时，空格后的词到这里为止。
  let softAfterSpace = -1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === " " && allowSpaces) {
      if (pending >= 0) break;
      pending = j;
      j += 1;
      continue;
    }
    if (isSoftStop(ch)) {
      if (pending < 0) pending = j;
      else if (s[pending] === " " && softAfterSpace < 0) softAfterSpace = j;
      j += 1;
      continue;
    }
    if (hard(ch)) break;
    const afterSpace = pending >= 0 && s[pending] === " ";
    if (isSep(ch)) {
      // 空格后紧跟分隔符（`\\`、`/` 开头）视为新路径，不续接。
      if (afterSpace && j === pending + 1) {
        newPath = true;
        break;
      }
      lastSep = j;
      pending = -1;
      softAfterSpace = -1;
    } else if (afterSpace && pathStart(s, j) >= 0) {
      newPath = true;
      break;
    }
    j += 1;
  }
  if (pending < 0) return [j, lastSep];
  // 文件名含一个空格（`a b.pdf`）：空格前的末段没有扩展名、空格后的词以扩展名结尾时，把这个词算进文件名。
  const wordEnd = softAfterSpace >= 0 ? softAfterSpace : j;
  if (
    leafSpace &&
    !newPath &&
    s[pending] === " " &&
    !EXT_AT_END.test(s.slice(lastSep + 1, pending)) &&
    EXT_AT_END.test(s.slice(pending + 1, wordEnd))
  ) {
    return [wordEnd, lastSep];
  }
  return [pending, lastSep];
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
  // 堆栈位置 `x.ts:12:5` / `y.js:3`：文件名保留，行列号原样跟在后面。
  const loc = /^(.*\.[A-Za-z0-9]{1,8})((?::\d+){1,2})$/.exec(name);
  if (loc) {
    name = loc[1];
    rest = loc[2] + rest;
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
  const out: string[] = [];
  let lastOut = "";
  const emit = (t: string) => {
    if (t) {
      out.push(t);
      lastOut = t[t.length - 1];
    }
  };
  let i = 0;
  while (i < s.length) {
    const from = pathStart(s, i);
    if (from < 0) {
      emit(s[i]);
      i += 1;
      continue;
    }
    const bsRoot = s[i] === "\\" && s[i + 1] !== "\\";
    const isUnix = s[i] === "/" || s[i] === "~" || bsRoot;
    // 斜杠写法（`/`、`~`）与 Windows / UNC 都允许目录名含空格；文件名含空格（`a b.pdf`）只对 Windows / UNC 处理。
    const [end, lastSep] = scanPath(s, from, !bsRoot, !isUnix);
    const [text, rest] = renderLeaf(s.slice(lastSep + 1, end));
    // Unix / 反斜杠根路径至少一级目录；反斜杠根路径没有文件名时，还要求至少一段目录名不少于 2 个字符，
    // 避免误伤 `\n\t` 之类单字母转义（`\Users\bob\Desktop` 照常换成「本机路径」）。
    if ((isUnix && lastSep <= i) || (bsRoot && text === LOCAL_PLACEHOLDER && !/[^\\/]{2}/.test(s.slice(i, end)))) {
      emit(s[i]);
      i += 1;
      continue;
    }
    if (isCjkText(lastOut)) emit(" ");
    emit(text);
    const after = rest || s[end];
    if (isCjkText(after?.[0])) emit(" ");
    emit(rest);
    i = end;
  }
  return out.join("");
}

// 只有 `http://`、`https://`（大小写不限）算网址。其他协议（`x://`、`git+ssh://`、`file://`）按普通路径扫描。
// 后顾断言保证只在词首尝试匹配。网址本身由 redactUrlAt 逐字扫描，整体线性。
const URL_START = /(?<![A-Za-z0-9+.-])https?:\/\//gi;
/** 网址普通字符：ASCII 且不是空白、引号、反引号、尖括号。 */
function isUrlChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c > 0x20 && c < 0x7f && !"\"'`<>".includes(ch);
}
/** 网址内夹带的路径到这些字符为止（中文、emoji 等不算终点）。 */
const URL_PATH_STOP = new Set([..."&#?\"'`<>，。；：、（）【】「」！？"]);
const URL_USERINFO_MASK = "***";
const URL_HOME_DIRS = ["Users/", "home/", "root/", "var/folders/", "private/var/"];

/** j 处是否开始一段网址内夹带的本机路径；返回替换文本，不是返回 null。 */
function urlPathAt(s: string, j: number, known: string[]): string | null {
  for (const k of known) {
    if (s.startsWith(k, j)) return k.startsWith("/") ? `/${LOCAL_PLACEHOLDER}` : LOCAL_PLACEHOLDER;
  }
  const ch = s[j];
  if (ch === "/" && URL_HOME_DIRS.some((d) => s.startsWith(d, j + 1))) return `/${LOCAL_PLACEHOLDER}`;
  if (ch === "\\") return LOCAL_PLACEHOLDER;
  const prev = j > 0 ? s[j - 1] : "";
  if (isAsciiLetter(ch) && !/[A-Za-z0-9]/.test(prev) && s[j + 1] === ":" && isSep(s[j + 2] || "")) return LOCAL_PLACEHOLDER;
  return null;
}

/**
 * 网址内路径的结束位置：到 `& # ?`、空白、引号、反引号、尖括号或中文标点为止（中文、emoji 不算终点）。
 * Windows 写法（盘符、反斜杠）的空格与网址外 scanPath 同一规则：空格后的词在空白、终点字符或新路径起点之前
 * 出现分隔符才续接；空格前末段无扩展名、空格后的词以扩展名结尾（`a b.pdf`）时把这个词算进来。单趟扫描，线性。
 */
function urlPathEnd(s: string, from: number, leafSpace: boolean): number {
  return scanRun(s, from, true, leafSpace, (ch) => isSpace(ch) || URL_PATH_STOP.has(ch))[0];
}

/**
 * 从 start 处的网址开始扫描，返回 [脱敏后的网址, 结束位置]。协议 + 主机原样保留；主机之后夹带的本机路径整段替换
 * （以 `/` 开头的写成 `/本机路径`，Windows 写法写成 `本机路径`），路径之后网址照常继续。
 */
function redactUrlAt(s: string, start: number, known: string[]): [string, number] {
  const out: string[] = [];
  const authStart = s.indexOf("://", start) + 3;
  let h = authStart;
  let at = -1;
  while (h < s.length && isUrlChar(s[h]) && !"/?#\\".includes(s[h])) {
    if (s[h] === "@") at = h;
    h += 1;
  }
  // 用户名 / 密码（`user:pass@`、`user@`，到最后一个 `@` 为止）整段换成 `***@`，主机与端口保留。
  out.push(at >= 0 ? `${s.slice(start, authStart)}${URL_USERINFO_MASK}${s.slice(at, h)}` : s.slice(start, h));
  let j = h;
  while (j < s.length) {
    const repl = urlPathAt(s, j, known);
    if (repl !== null) {
      out.push(repl);
      j = urlPathEnd(s, j, !repl.startsWith("/"));
      continue;
    }
    if (!isUrlChar(s[j])) break;
    out.push(s[j]);
    j += 1;
  }
  return [out.join(""), j];
}

/** 输出上限：脱敏后超过这个长度只保留前这么多字符，后面不输出，改为追加 TRUNCATED_MARK。 */
const REDACT_MAX_CHARS = 8000;
const TRUNCATED_MARK = "（后面省略）";

/** 编码分隔符最多解几层（`%2F` 一层、`%252F` 两层、`%25252F` 三层）。 */
const MAX_DECODE_LAYERS = 3;

/**
 * 还原 URL 编码的分隔符：每层先把 `%5C` / `%2F` 还原，再把紧挨分隔符编码的一层 `%25` 剥掉，
 * 循环到不再变化，最多 MAX_DECODE_LAYERS 层。不挨着 `2F` / `5C` 的 `%25` 原样保留。
 */
function decodeSeparators(input: string): string {
  let s = input;
  for (let k = 0; k < MAX_DECODE_LAYERS; k += 1) {
    const next = s
      .replace(/%5c/gi, "\\")
      .replace(/%2f/gi, "/")
      .replace(/%25((?:25)*)(2f|5c)/gi, "%$1$2");
    if (next === s) break;
    s = next;
  }
  return s;
}

export function redactLocalPaths(message: string | undefined | null): string {
  // ① 整条解码 + 脱敏（线性，不先截断，避免截断点落在网址密码等中间漏出半截）；② 脱敏后超过 REDACT_MAX_CHARS 字符
  // 只保留前这么多字符，截断点落在代理对中间时往前退一位；③ 截过就追加「（后面省略）」。
  let s = redactLocalPathsUncapped(message);
  const truncated = s.length > REDACT_MAX_CHARS;
  if (truncated) {
    const hi = s.charCodeAt(REDACT_MAX_CHARS - 1);
    s = s.slice(0, hi >= 0xd800 && hi <= 0xdbff ? REDACT_MAX_CHARS - 1 : REDACT_MAX_CHARS);
  }
  return s + (truncated ? TRUNCATED_MARK : "");
}

/** 不截断的完整脱敏（解码 + 网址处理 + 路径扫描）。redactLocalPaths 先调它再截断；业务代码请用 redactLocalPaths。 */
export function redactLocalPathsUncapped(message: string | undefined | null): string {
  const s = String(message ?? "");
  return s ? redactDecoded(decodeSeparators(s)) : s;
}

function redactDecoded(s: string): string {
  // 已配置路径每条报错只读一次（读设置有开销，不能按片段反复读）。
  const known = knownLocalPaths();
  const parts: string[] = [];
  let last = 0;
  URL_START.lastIndex = 0;
  for (let m = URL_START.exec(s); m; m = URL_START.exec(s)) {
    const [text, end] = redactUrlAt(s, m.index, known);
    parts.push(redactPlain(s.slice(last, m.index), known), text);
    last = end;
    URL_START.lastIndex = end;
  }
  parts.push(redactPlain(s.slice(last), known));
  return parts.join("");
}

function redactPlain(input: string, knownPaths: string[]): string {
  let s = input;
  if (!s) return s;
  // file:// 前缀去掉，后面按普通路径处理（file:///Users/... → /Users/...，file:///C:/... → C:/...）。
  s = s.replace(/file:\/\/\/?(?=[A-Za-z]:[\\/])/gi, "").replace(/file:\/\/(?=\/)/gi, "");
  // 先处理已知目录（可能含空格，如 C:\Program Files\...）：整段是文件就换成文件名，是目录就换占位，其下文件再留文件名。
  for (const known of knownPaths) {
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
