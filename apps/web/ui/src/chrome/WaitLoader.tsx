import { waitLoaderLetters, type WaitKind } from "../pages/waitCard";

/** 等待圆盘。字母用检查中 / 复核中 / 生成中，不要英文 Generating。 */
export function WaitLoader({ kind }: { kind: WaitKind }) {
  return (
    <div className="wait-loader" aria-hidden>
      {waitLoaderLetters(kind).map((ch, i) => (
        <span key={`${kind}-${i}`} className="wait-loader-letter" style={{ animationDelay: `${i * 0.1}s` }}>
          {ch}
        </span>
      ))}
      <div className="wait-loader-disc" />
    </div>
  );
}
