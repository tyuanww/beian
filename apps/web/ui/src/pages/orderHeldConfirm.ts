import type { FieldHit, TaskDetail } from "../api";
import { isOpenHeld } from "./reviewFlat";

/**
 * 和后端 /complete 对齐：verbatim_check 单且有 verbatim_warning、
 * 还有未决「待人工确认」时，必须带 order_held_confirm: true。
 */
export function needsOrderHeldConfirm(
  task: Pick<TaskDetail, "verbatim_check" | "verbatim_warning"> | null | undefined,
  hits: readonly FieldHit[],
): boolean {
  if (!task?.verbatim_check || !task.verbatim_warning) return false;
  return hits.some(isOpenHeld);
}

/** 需要整单确认却没勾时，签字不可用。 */
export function signAllowedForOrderHeld(needsConfirm: boolean, confirmed: boolean): boolean {
  return !needsConfirm || confirmed;
}

export function completePayload(conclusion: string, orderHeldConfirm: boolean): {
  conclusion: string;
  order_held_confirm?: boolean;
} {
  return orderHeldConfirm
    ? { conclusion, order_held_confirm: true }
    : { conclusion };
}
