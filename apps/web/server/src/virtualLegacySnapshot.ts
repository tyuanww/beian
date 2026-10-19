import { realpathSync } from "node:fs";
import { resolve } from "node:path";

type VirtualSnapStat = { ino: number; dev: number; size: number; mtimeMs: number; nlink: number };

export type VirtualSnapRow =
  | { key: string; missing: true }
  | { key: string; sha256: string; bytes: number; path: string; stat: VirtualSnapStat };

export type VirtualSnap = { id: string; rows: VirtualSnapRow[] };

type PresentVirtualRow = Exclude<VirtualSnapRow, { missing: true }>;

const virtualSnapByRoot = new Map<string, VirtualSnap>();
const VIRTUAL_SNAP_LIMIT = 64;

function virtualSnapKey(root: string): string {
  try { return realpathSync(root); } catch { return root; }
}

export function isPresentVirtualRow(row: VirtualSnapRow): row is PresentVirtualRow {
  return !("missing" in row);
}

export function virtualSnapDigestFiles(rows: readonly VirtualSnapRow[]): Array<{ key: string; missing: true } | { key: string; sha256: string; bytes: number }> {
  return rows.map((row) => isPresentVirtualRow(row)
    ? { key: row.key, sha256: row.sha256, bytes: row.bytes }
    : { key: row.key, missing: true });
}

export function rememberVirtualSnap(root: string, snap: VirtualSnap): void {
  const key = virtualSnapKey(root);
  if (virtualSnapByRoot.has(key)) virtualSnapByRoot.delete(key);
  virtualSnapByRoot.set(key, snap);
  while (virtualSnapByRoot.size > VIRTUAL_SNAP_LIMIT) {
    const oldest = virtualSnapByRoot.keys().next().value;
    if (oldest === undefined) break;
    virtualSnapByRoot.delete(oldest);
  }
}

export function readVirtualSnap(root: string): VirtualSnap | undefined {
  return virtualSnapByRoot.get(virtualSnapKey(root));
}

export function forgetVirtualSnap(root: string): void {
  virtualSnapByRoot.delete(virtualSnapKey(root));
}

type SnapStat = {
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
  nlink: number;
  isSymbolicLink(): boolean;
  isFile(): boolean;
};

export function virtualStatsHold(
  snap: VirtualSnap,
  sources: ReadonlyArray<{ key: string; path: string }>,
  stat: (path: string) => SnapStat | null,
): boolean {
  const present = snap.rows.filter(isPresentVirtualRow);
  if (sources.length !== present.length) return false;
  for (const row of snap.rows) {
    const src = sources.find((item) => item.key === row.key);
    if (!isPresentVirtualRow(row)) {
      if (src) return false;
      continue;
    }
    if (!src || resolve(src.path) !== resolve(row.path)) return false;
    const st = stat(src.path);
    if (!st || st.isSymbolicLink() || !st.isFile()) return false;
    if (st.ino !== row.stat.ino || st.dev !== row.stat.dev || st.size !== row.stat.size
      || st.mtimeMs !== row.stat.mtimeMs || st.nlink !== row.stat.nlink) return false;
  }
  return true;
}
