import { useEffect, useState } from "react";
import { api } from "../api";
import { feishuReadyFromHealth, waitCardActiveSteps, waitCardCopy, type WaitKind } from "../pages/waitCard";
import { WaitLoader } from "./WaitLoader";

/** 逻辑只认 WaitKind；中文步骤只是显示。 */
const STEPS: Record<WaitKind, string[]> = {
  compare: ["读取表格", "读取稿件", "找出差异"],
  rework: ["读取表格", "读取稿件", "找出差异"],
  mockup: ["读取设计稿", "搭出盒子", "生成效果图", "打包文件"],
};

type Props = {
  kind: WaitKind;
  activeSteps?: number;
  queueAhead?: number;
  stage?: string;
  stageLabel?: string;
  etaS?: number;
  hint?: string;
  jobStatus?: string;
  feishuReady?: boolean;
};

export function WaitCard({
  kind,
  activeSteps,
  queueAhead,
  stage,
  stageLabel,
  etaS,
  hint,
  jobStatus,
  feishuReady,
}: Props) {
  const [ready, setReady] = useState(Boolean(feishuReady));
  useEffect(() => {
    if (feishuReady != null) {
      setReady(feishuReady);
      return;
    }
    let cancelled = false;
    void api
      .status()
      .then((h) => {
        if (!cancelled) setReady(feishuReadyFromHealth(h));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [feishuReady]);

  const steps = STEPS[kind];
  const copy = waitCardCopy({
    kind,
    job_status: jobStatus,
    job_stage_label: stageLabel,
    job_eta_s: etaS,
    queue_ahead: queueAhead,
    feishuReady: ready,
  });
  const stepsOn = activeSteps != null ? activeSteps : waitCardActiveSteps(kind, jobStatus, stage, stageLabel);
  return (
    <div className="wait-wrap">
      <div className="wait-card" role="status" aria-live="polite">
        <WaitLoader kind={kind} />
        <h2 className="wait-title">{copy.title}</h2>
        <p className="wait-eta">{copy.eta}</p>
        <p className="wait-hint">{hint ?? copy.hint}</p>
        <div className="wait-bar" aria-hidden>
          <span className={kind === "mockup" ? "wait-bar-fill is-slow" : "wait-bar-fill"} />
        </div>
        <div className="wait-steps">
          {steps.map((s, i) => (
            <span key={s} className={i < stepsOn ? "wait-chip is-on" : "wait-chip"}>
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
