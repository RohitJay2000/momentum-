import { formatMinutes } from "../domain/format";
import type { SessionRecap } from "../platform/native";

export interface FocusRecap {
  label: string;
  recap: SessionRecap;
}

interface Props {
  recap: FocusRecap;
  onDismiss: () => void;
}

const minutes = (ms: number) => ms / 60_000;

/** Kind, factual feedback after a focus session: what it actually looked like. */
export function recapMessage(percent: number | null): string {
  if (percent === null) return "Momentum didn't see activity on the Mac during this session.";
  if (percent >= 80) return "Deep focus. That's the good stuff.";
  if (percent >= 50) return "Solid session. A few detours, and you came back.";
  return "Lots of detours this time. Smaller steps can make the next one easier.";
}

export function SessionRecapCard({ recap: { label, recap }, onDismiss }: Props) {
  const top = recap.topPlaces;

  return (
    <section className="panel recap" aria-labelledby="recap-title" data-testid="session-recap">
      <div className="recap-head">
        <h2 id="recap-title">Focus session recap</h2>
        <button type="button" className="btn-icon" aria-label="Dismiss recap" onClick={onDismiss}>
          ×
        </button>
      </div>
      <p className="muted small recap-label">“{label}”</p>
      <div className="recap-stats">
        <div>
          <strong data-testid="recap-focus">{recap.focusPercent === null ? "–" : `${recap.focusPercent}%`}</strong>
          <span className="muted small">focused</span>
        </div>
        <div>
          <strong>{formatMinutes(minutes(recap.trackedMs))}</strong>
          <span className="muted small">at the Mac</span>
        </div>
        <div>
          <strong>{formatMinutes(minutes(recap.totals.distractionMs))}</strong>
          <span className="muted small">distracted</span>
        </div>
      </div>
      <p className="recap-msg">{recapMessage(recap.focusPercent)}</p>
      {top.length > 0 && (
        <ol className="top-apps" aria-label="Where the time went">
          {top.map((t) => (
            <li key={`${t.name}-${t.category}`}>
              <span className={`swatch cat-bg-${t.category}`} aria-hidden="true" />
              <span className="app-name">{t.name}</span>
              <span className="muted">{formatMinutes(minutes(t.ms))}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
