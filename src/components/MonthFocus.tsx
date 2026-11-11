import { formatMonthDay, formatMonthName, toMonthKey } from "../domain/dates";
import { upcomingKeyDates } from "../domain/metrics";
import type { AppState, DateKey } from "../domain/types";

interface Props {
  state: AppState;
  today: DateKey;
  onOpenWarMap: () => void;
}

export function countdown(daysAway: number): string {
  if (daysAway === 0) return "today";
  if (daysAway === 1) return "tomorrow";
  return `in ${daysAway} days`;
}

/** This month's objectives and the next key dates, above today's plan. */
export function MonthFocus({ state, today, onOpenWarMap }: Props) {
  const month = toMonthKey(today);
  const monthName = formatMonthName(Number(month.slice(5, 7)) - 1);
  const objectives = state.objectives[month] ?? [];
  const upcoming = upcomingKeyDates(state, today, 2);

  if (objectives.length === 0 && upcoming.length === 0) {
    return (
      <button type="button" className="month-prompt" onClick={onOpenWarMap}>
        Give {monthName} up to 3 main objectives and mark key dates → War Map
      </button>
    );
  }

  return (
    <section className="panel month-focus" aria-labelledby="month-focus-title">
      <div className="month-focus-head">
        <h2 id="month-focus-title">{monthName} objectives</h2>
        <button type="button" className="btn btn-ghost small" onClick={onOpenWarMap}>
          Open War Map
        </button>
      </div>
      {objectives.length > 0 ? (
        <ol className="month-obj" data-testid="month-objectives">
          {objectives.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No objectives set for {monthName}.</p>
      )}
      {upcoming.length > 0 && (
        <ul className="key-dates" aria-label="Upcoming key dates">
          {upcoming.map((u) => (
            <li key={u.date} data-testid="key-date">
              <strong>{u.label}</strong>{" "}
              <span className={`countdown ${u.daysAway <= 3 ? "is-soon" : ""}`}>{countdown(u.daysAway)}</span>{" "}
              <span className="muted">({formatMonthDay(u.date)})</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
