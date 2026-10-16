import type { Decision, FieldHit } from "../api";

export type Verdict = Extract<Decision, "confirm" | "issue" | "ignore">;

const ALL: readonly Verdict[] = ["confirm", "issue", "ignore"];
const HELD: readonly Verdict[] = ["issue", "ignore"];

/** 机器认不准的字（待人工确认）。 */
export function isHeldStatus(hit: Pick<FieldHit, "status"> | undefined): boolean {
  return hit?.status === "待人工确认";
}

/**
 * 这一条能下哪些结论。按钮、键盘 1/2/3、decide() 都走这里。
 * 和服务端 /decision 对齐：待人工确认不能选一致（服务端回 400「待人工确认不能选一致」）。
 */
export function allowedDecisions(hit: Pick<FieldHit, "status"> | undefined): readonly Verdict[] {
  return isHeldStatus(hit) ? HELD : ALL;
}

export function isDecisionAllowed(hit: Pick<FieldHit, "status"> | undefined, decision: Decision): boolean {
  return (allowedDecisions(hit) as readonly string[]).includes(decision);
}
