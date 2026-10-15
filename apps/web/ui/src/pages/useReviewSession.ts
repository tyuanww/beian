import { useMemo, useState } from "react";

/** 手机卸卡只退当前这一条。就地对照关着时，右栏草稿留着。 */
export function spotPhoneDiscardId(
  layout: string,
  spotOn: boolean,
  activeId: string | undefined,
  draft: string | null | undefined,
  saved: string | null | undefined,
): string | null {
  if (layout !== "phone" || !spotOn || !activeId) return null;
  if (draft == null || draft === (saved ?? "")) return null;
  return activeId;
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
