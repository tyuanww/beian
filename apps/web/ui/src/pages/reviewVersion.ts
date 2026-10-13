import type { FieldHit, TaskDetail } from "../api";

export function shouldUseReworkView(task: TaskDetail | null): boolean {
  if (task?.verbatim_check === true && Array.isArray(task.hits_v2)) return task.hits_v2.length > 0 || Array.isArray(task.pages_v2);
  return Boolean(
    (Array.isArray(task?.hits_v2) && task.hits_v2.length > 0) ||
      (Array.isArray(task?.pages_v2) && task.pages_v2.length > 0),
  );
}

/** 有标记时空数组表示这轮没有错。没有标记的旧单仍回退第一轮。 */
export function reviewHits(task: TaskDetail | null, useV2: boolean): FieldHit[] {
  if (task?.verbatim_check === true && useV2 && Array.isArray(task.hits_v2)) return task.hits_v2;
  if (useV2 && Array.isArray(task?.hits_v2) && task.hits_v2.length > 0) return task.hits_v2;
  return Array.isArray(task?.hits) ? task.hits : [];
}
