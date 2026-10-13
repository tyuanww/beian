import { useState } from "react";
import { Input, Modal } from "antd";
import { REVIEW_COPY } from "../copy/labels";
import type { RejectRow } from "./reviewFlat";

type Props = {
  kind: "sign" | "reject" | null;
  rows: RejectRow[];
  /** 还没下结论的条数；>0 时服务端不收 /complete，确认按钮挡住。 */
  pending?: number;
  held?: number;
  busy: boolean;
  /** 失败提示文案；null = 没失败。 */
  failed: string | null;
  onCancel: () => void;
  onConfirm: (extra: string) => void;
};

/** 签字/退回确认框；文案按 deviations.md 第 33–35b 行（已批 2026-10-11）。提交失败不关框、不清补充说明。 */
export function ReviewSubmitDialog({ kind, rows, pending = 0, held = 0, busy, failed, onCancel, onConfirm }: Props) {
  const [extra, setExtra] = useState("");
  const reject = kind === "reject";
  const blocked = pending > 0;
  return (
    <Modal
      open={kind != null}
      title={reject ? REVIEW_COPY.rejectTitle : REVIEW_COPY.signTitle}
      okText={failed ? REVIEW_COPY.retry : reject ? REVIEW_COPY.rejectConfirm : REVIEW_COPY.signConfirm}
      cancelText={REVIEW_COPY.cancel}
      okButtonProps={{ danger: reject, loading: busy, disabled: blocked, autoInsertSpace: false }}
      cancelButtonProps={{ autoInsertSpace: false }}
      onCancel={onCancel}
      onOk={() => { if (!blocked) onConfirm(extra); }}
      mask={{ closable: !busy }}
      destroyOnHidden={false}
      className="review-submit-dialog"
    >
      {reject && blocked ? <p id="review-reject-blocked" className="review-submit-error review-reject-blocked" role="status">{REVIEW_COPY.rejectBlockedByPending(pending)}</p> : null}
      <p>{reject ? REVIEW_COPY.rejectBody(rows.length) : REVIEW_COPY.signBody}</p>
      {!reject && held > 0 ? <p data-testid="review-sign-held">{REVIEW_COPY.heldLine(held)}</p> : null}
      {reject ? (
        <>
          <ul className="review-reject-list" aria-label="有错清单">
            {rows.map((row) => (
              <li key={row.index}>
                <b>#{row.no} {row.field}</b>
                {row.missingReason ? <span className="review-miss">{REVIEW_COPY.missingReason}</span> : <span className="review-reason">{row.reason}</span>}
              </li>
            ))}
          </ul>
          <label className="review-extra">
            <span>{REVIEW_COPY.extraNote}</span>
            <Input.TextArea aria-label={REVIEW_COPY.extraNote} disabled={blocked} aria-describedby={blocked ? "review-reject-blocked" : undefined} autoSize={{ minRows: 2, maxRows: 5 }} value={extra} onChange={(e) => setExtra(e.target.value)} />
          </label>
        </>
      ) : null}
      {failed ? <p className="review-submit-error" role="alert">{failed}</p> : null}
    </Modal>
  );
}
