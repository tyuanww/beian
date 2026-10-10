import type { TaskDetail, TaskPage } from "../api";
import { REVIEW_STATUS_LABEL, reviewCompletedLabel } from "../copy/labels";

/** 审稿详情页标题下的一行状态。完成态按 complete_kind 区分，老记录保持「已提交」。 */
export function statusLead(task: TaskDetail | null, pageIdx: number, pages: TaskPage[]) {
  const pageNo = pages[pageIdx]?.page || pageIdx + 1;
  if (!task) return "审核页";
  if (task.status === "completed") return `第 ${pageNo} 页 · ${reviewCompletedLabel(task.complete_kind)}`;
  if (task.status === "pending_review" || task.status === "in_review") return `第 ${pageNo} 页 · ${REVIEW_STATUS_LABEL.pending}`;
  if (task.status === "compare_failed") return `第 ${pageNo} 页 · 检查中断`;
  return `第 ${pageNo} 页`;
}
