import { useMemo, useState } from "react";
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
  };
}
