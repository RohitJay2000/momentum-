import { useState } from "react";
import { formatMinutes } from "../domain/format";
import type { Category, CategoryTotals, NativeApi } from "../platform/native";
import type { TrackerState } from "../platform/useTracker";

const CATEGORY_LABEL: Record<Category, string> = {
  focus: "Focus",
  communication: "Communication",
  distraction: "Distraction",
  other: "Other",
};

const ORDER: Category[] = ["focus", "communication", "other", "distraction"];

export const msOf = (t: CategoryTotals, c: Category): number =>
  c === "focus" ? t.focusMs : c === "communication" ? t.communicationMs : c === "distraction" ? t.distractionMs : t.otherMs;

const minutes = (ms: number) => ms / 60_000;

/** Hours to draw: the active span of the day, at least 9:00–18:00. */
export function hourRange(hours: CategoryTotals[]): [number, number] {
  const active = hours
    .map((h, i) => ({ i, total: h.focusMs + h.communicationMs + h.distractionMs + h.otherMs }))
    .filter((h) => h.total > 0)
    .map((h) => h.i);
  const first = Math.min(9, ...active);
  const last = Math.max(17, ...active);
  return [first, last];
}

interface Props {
  api: NativeApi;
  tracker: TrackerState;
}

export function ActivityPanel({ api, tracker }: Props) {
  const { status, summary, config, error } = tracker;
  const [asked, setAsked] = useState(false);

  if (!api.available) {
    return (
      <section className="panel activity" aria-labelledby="activity-title">
        <h2 id="activity-title">Today on your Mac</h2>
        <p className="muted">
          Automatic tracking, the focus guard and break reminders run in the Momentum Mac app.
        </p>
      </section>
    );
  }

  if (status && !status.supported) {
    return (
      <section className="panel activity" aria-labelledby="activity-title">
        <h2 id="activity-title">Today on your Mac</h2>
        <p className="muted">Automatic tracking and the focus guard are available on macOS.</p>
      </section>
    );
  }

  const toggleTracking = () => {
    if (config) void tracker.saveConfig({ ...config, trackingEnabled: !config.trackingEnabled });
  };

  const askAccessibility = async () => {
    setAsked(true);
    await api.requestAccessibility();
    void tracker.refresh();
  };

  const total = summary?.activeMs ?? 0;
  const [h0, h1] = summary ? hourRange(summary.hours) : [9, 17];
  const hourMax = Math.max(
    60 * 60_000 / 2,
    ...(summary?.hours ?? []).map((h) => h.focusMs + h.communicationMs + h.distractionMs + h.otherMs),
  );

  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <div className="activity-head">
        <h2 id="activity-title">Today on your Mac</h2>
        {config && (
          <label className="switch">
            <input type="checkbox" checked={config.trackingEnabled} onChange={toggleTracking} />
            <span>{config.trackingEnabled ? "Tracking" : "Paused"}</span>
          </label>
        )}
      </div>

      {error && (
        <p className="callout callout-warn" role="alert">
          Tracker problem: {error}
        </p>
      )}

      {status && (
        <p className="now" data-testid="now-activity">
          {!status.trackingEnabled
            ? "Tracking is paused. Nothing is being recorded."
            : status.idle
              ? "You're away — tracking resumes when you're back."
              : status.current
                ? (
                    <>
                      Now: <strong>{status.current.appName}</strong>{" "}
                      <span className={`cat cat-${status.current.category}`}>
                        {CATEGORY_LABEL[status.current.category]}
                      </span>
                    </>
                  )
                : "Waiting for activity…"}
        </p>
      )}

      {status && !status.accessibilityTrusted && (
        <div className="callout callout-info">
          <p>
            Allow <strong>Accessibility</strong> so Momentum can spot distracting browser tabs like YouTube. Window
            titles stay on this Mac.
          </p>
          <button type="button" className="btn" onClick={() => void askAccessibility()}>
            Allow…
          </button>
          {asked && (
            <p className="muted small">
              In System Settings → Privacy &amp; Security → Accessibility, turn on Momentum. It may take a few
              seconds to apply.
            </p>
          )}
        </div>
      )}

      {summary && (
        <>
          <div className="activity-total">
            <strong data-testid="active-total">{formatMinutes(minutes(total))}</strong>
            <span className="muted"> active today</span>
          </div>
          <div className="stack" role="img" aria-label="Time by category">
            {ORDER.map((c) => {
              const ms = msOf(summary.totals, c);
              return ms > 0 && total > 0 ? (
                <div key={c} className={`stack-part cat-bg-${c}`} style={{ width: `${(ms / total) * 100}%` }} />
              ) : null;
            })}
          </div>
          <ul className="legend">
            {ORDER.map((c) => (
              <li key={c}>
                <span className={`swatch cat-bg-${c}`} aria-hidden="true" />
                {CATEGORY_LABEL[c]} <strong>{formatMinutes(minutes(msOf(summary.totals, c)))}</strong>
              </li>
            ))}
          </ul>

          <figure className="hours" aria-label="Activity by hour">
            <div className="hour-cols">
              {summary.hours.slice(h0, h1 + 1).map((h, i) => {
                const hour = h0 + i;
                return (
                  <div key={hour} className="hour-col" title={`${hour}:00`}>
                    <div className="hour-stack">
                      {ORDER.map((c) => {
                        const ms = msOf(h, c);
                        return ms > 0 ? (
                          <div key={c} className={`cat-bg-${c}`} style={{ height: `${(ms / hourMax) * 100}%` }} />
                        ) : null;
                      })}
                    </div>
                    <span className="hour-label">{hour % 3 === 0 ? hour : ""}</span>
                  </div>
                );
              })}
            </div>
          </figure>

          {summary.topApps.length > 0 && (
            <ol className="top-apps">
              {summary.topApps.map((a) => (
                <li key={`${a.bundleId}-${a.category}`}>
                  <span className={`swatch cat-bg-${a.category}`} aria-hidden="true" />
                  <span className="app-name">{a.appName}</span>
                  <span className="muted">{formatMinutes(minutes(a.ms))}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
