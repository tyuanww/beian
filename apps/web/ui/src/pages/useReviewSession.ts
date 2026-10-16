import { useMemo, useState } from "react";

/**
 * 手机看不到逐条备注框。进入手机时不再丢草稿（首次打开也不丢）：
 * 能存的（这条已有结论）直接带原结论存上；存不了的（还没结论）只能丢，丢之前要人确认。
 */
export function phoneDraftPlan(
  hits: ReadonlyArray<{ id?: string; decision?: string; note?: string | null }>,
  drafts: Readonly<Record<string, string>>,
): { save: Array<{ id: string; decision: "confirm" | "issue" | "ignore"; note: string }>; drop: string[] } {
  const save: Array<{ id: string; decision: "confirm" | "issue" | "ignore"; note: string }> = [];
  const drop: string[] = [];
  for (const hit of hits) {
    if (!hit.id) continue;
    const draft = drafts[hit.id];
    if (draft == null || draft === (hit.note ?? "")) continue;
    const d = hit.decision;
    if (d === "confirm" || d === "issue" || d === "ignore") save.push({ id: hit.id, decision: d, note: draft });
    else drop.push(hit.id);
  }
  return { save, drop };
}

import { reviewStorage, readReviewSession, reviewSessionKey, writeReviewSession, type ReviewSession } from "./reviewWorkspaceState";

export function useReviewSession(user: string | null, task: string | null, version: boolean) {
  const key = reviewSessionKey(user, task, version);
  const initial = useMemo(() => readReviewSession(reviewStorage(), key), [key]);
  const [state, setState] = useState<{ key: string | null; value: ReviewSession }>({ key, value: initial });
  const value = state.key === key ? state.value : initial;
  function update(change: (previous: ReviewSession) => ReviewSession) {
    setState((previous) => {
      const next = change(previous.key === key ? previous.value : initial);
      writeReviewSession(reviewStorage(), key, next);
      return { key, value: next };
    });
  }
  return {
    notes: value.drafts,
    savedHitId: value.activeId,
    rememberHit: (activeId?: string) => update((previous) => ({ ...previous, activeId })),
    setNote: (id: string, note: string) => update((previous) => ({ ...previous, drafts: { ...previous.drafts, [id]: note } })),
    clearNote: (id: string, saved: string) => update((previous) => {
      if (previous.drafts[id] !== saved) return previous;
      const drafts = { ...previous.drafts };
      delete drafts[id];
      return { ...previous, drafts };
    }),
    /** 丢掉未提交的本地原因，让 noteFor 回到已保存的 hit.note。 */
    discardDraft: (id: string) => update((previous) => {
      if (!Object.prototype.hasOwnProperty.call(previous.drafts, id)) return previous;
      const drafts = { ...previous.drafts };
      delete drafts[id];
      return { ...previous, drafts };
    }),
  };
}
