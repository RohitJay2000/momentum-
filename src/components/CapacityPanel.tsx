import { formatShortDay } from "../domain/dates";
import { formatMinutes } from "../domain/format";
import { CAPACITY_WINDOW_DAYS, STRETCH_STREAK, checkPlan, type Capacity } from "../domain/metrics";
import type { DateKey } from "../domain/types";

interface Props {
  capacity: Capacity;
  today: DateKey;
  todayWorkMinutes: number;
  todayPlannedMinutes: number;
}

export function CapacityPanel({ capacity, today, todayWorkMinutes, todayPlannedMinutes }: Props) {
  const plan = checkPlan(capacity, todayPlannedMinutes);
  const bars = [
    ...[...capacity.history].reverse().map((d) => ({ ...d, isToday: false })),
    { date: today, workMinutes: todayWorkMinutes, allGoalsDone: false, isToday: true },
  ];
  const line = capacity.status === "ready" ? capacity.consistentMinutes : 0;
  const scale = Math.max(60, line, ...bars.map((b) => b.workMinutes));

  return (
    <section className="panel capacity" aria-labelledby="capacity-title">
      <h2 id="capacity-title">Your consistent capacity</h2>

      {capacity.status === "calibrating" ? (
        <div className="calibrating">
          <p className="capacity-lead">
            Finding the most real work you can do <em>every</em> day — not on your best day.
          </p>
          <div className="dots" aria-label={`${capacity.daysLogged} of ${capacity.daysNeeded} days logged`}>
            {Array.from({ length: capacity.daysNeeded }, (_, i) => (
              <span key={i} className={`dot ${i < capacity.daysLogged ? "on" : ""}`} />
            ))}
          </div>
          <p className="muted">
            {capacity.daysNeeded - capacity.daysLogged === 1
              ? "1 more day of plans and you'll get your number."
              : `${capacity.daysNeeded - capacity.daysLogged} more days of plans and you'll get your number.`}{" "}
            Timed steps count real minutes; untimed finished steps count their estimate.
          </p>
        </div>
      ) : (
        <div className="ready">
          <p className="capacity-number" data-testid="capacity-number">
            {formatMinutes(capacity.consistentMinutes)}
          </p>
          <p className="capacity-lead">of real work, reached on at least 80% of your last {capacity.daysUsed} days.</p>
          <dl className="stats">
            <div>
              <dt>Average</dt>
              <dd>{formatMinutes(capacity.averageMinutes)}</dd>
            </div>
            <div>
              <dt>Best day</dt>
              <dd>{formatMinutes(capacity.bestMinutes)}</dd>
            </div>
          </dl>
          {capacity.stretchMinutes !== null && (
            <p className="callout callout-good" role="status">
              You've finished everything {STRETCH_STREAK} days running. Ready to stretch to{" "}
              <strong>{formatMinutes(capacity.stretchMinutes)}</strong>? Add one more small step.
            </p>
          )}
        </div>
      )}

      <div className="today-vs">
        <div>
          <span className="muted">Real work today</span>
          <strong data-testid="today-work">{formatMinutes(todayWorkMinutes)}</strong>
        </div>
        <div>
          <span className="muted">Planned today</span>
          <strong data-testid="today-planned">{formatMinutes(todayPlannedMinutes)}</strong>
        </div>
      </div>

      {plan.kind === "over" && (
        <p className="callout callout-warn" role="status">
          Today's plan is about {formatMinutes(plan.overByMinutes)} more than you reliably do. Move a step
          to tomorrow so today stays winnable.
        </p>
      )}
      {plan.kind === "ok" && plan.plannedMinutes > 0 && (
        <p className="callout callout-ok">Today's plan fits your capacity. 👍</p>
      )}

      <figure className="chart" aria-label={`Real work over the last ${bars.length} days`}>
        <div className="bars">
          {line > 0 && (
            <div className="plot-area" aria-hidden="true">
              <div className="cap-line" style={{ bottom: `${(line / scale) * 100}%` }}>
                <span>{formatMinutes(line)}</span>
              </div>
            </div>
          )}
          {bars.map((b) => (
            <div
              key={b.date}
              className={`bar ${b.isToday ? "is-today" : ""} ${b.allGoalsDone ? "is-allin" : ""}`}
              title={`${formatShortDay(b.date)}: ${formatMinutes(b.workMinutes)}`}
            >
              <div className="bar-fill" style={{ height: `${(b.workMinutes / scale) * 100}%` }} />
              <span className="bar-label">{b.isToday ? "Today" : formatShortDay(b.date)}</span>
            </div>
          ))}
        </div>
        <figcaption className="muted">
          Up to {CAPACITY_WINDOW_DAYS} recent planned days. Green = every non-negotiable done.
        </figcaption>
      </figure>
    </section>
  );
}
