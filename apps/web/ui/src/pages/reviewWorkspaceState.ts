import type { FieldHit } from "../api";
import { isPendingDecision } from "./reviewNav";
import { partitionReviewHits } from "./reviewEvidence";

export type ReviewSession = { activeId?: string; drafts: Record<string, string> };
type Store = Pick<Storage, "getItem" | "setItem"> | null;

export function reviewStorage(): Store {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function reviewSessionKey(user: string | null, task: string | null, version: boolean): string | null {
  return user && task ? `wb_review_session_v1:${encodeURIComponent(user)}:${encodeURIComponent(task)}:${version ? "v2" : "v1"}` : null;
}

export function readReviewSession(store: Store, key: string | null): ReviewSession {
  try {
    const raw = key ? JSON.parse(store?.getItem(key) || "null") : null;
    const drafts: Record<string, string> = {};
    if (raw?.drafts && typeof raw.drafts === "object" && !Array.isArray(raw.drafts)) {
      for (const [id, value] of Object.entries(raw.drafts)) {
        if (typeof value === "string") Object.defineProperty(drafts, id, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    return { activeId: typeof raw?.activeId === "string" ? raw.activeId : undefined, drafts };
  } catch { return { drafts: {} }; }
}

export function writeReviewSession(store: Store, key: string | null, value: ReviewSession): void {
  try { if (key) store?.setItem(key, JSON.stringify(value)); } catch { /* Keep the local draft if quota is full. */ }
}

export function issueNavigation(hits: FieldHit[], active: number, pendingOnly: boolean) {
  const issues = partitionReviewHits(hits).issues;
  const visible = issues.filter(({ hit }) => !pendingOnly || isPendingDecision(hit.decision));
  const previous = [...visible].reverse().find(({ index }) => index < active)?.index ?? null;
  const next = visible.find(({ index }) => index > active)?.index ?? null;
  const pending = issues.filter(({ hit, index }) => index !== active && isPendingDecision(hit.decision));
  const nextPending = pending.find(({ index }) => index > active)?.index ?? pending[0]?.index ?? null;
  return { visible, previous, next, nextPending };
}
