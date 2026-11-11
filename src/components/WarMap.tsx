import { useEffect, useState } from "react";
import {
  daysInMonth,
  formatDayLabel,
  formatMonthName,
  monthKeyOf,
  mondayOffset,
  toDateKey,
  toMonthKey,
} from "../domain/dates";
import { dayProgress, dayStatus, isGoalDone, type DayStatus } from "../domain/metrics";
import { MAX_KEY_DATE_LENGTH, MAX_OBJECTIVES, MAX_TITLE_LENGTH, type AppState, type DateKey } from "../domain/types";

interface Props {
  state: AppState;
  today: DateKey;
  onSetObjectives: (month: string, objectives: string[]) => void;
  onSetKeyDate: (date: DateKey, label: string) => void;
}

const STATUS_TEXT: Record<DayStatus, string> = {
  none: "no plan",
  planned: "planned",
  partial: "in progress",
  win: "every non-negotiable done",
};

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

export function WarMap({ state, today, onSetObjectives, onSetKeyDate }: Props) {
  const todayYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(todayYear);
  const [selected, setSelected] = useState<DateKey>(today);
  const selectedMonth = toMonthKey(selected);

  const [drafts, setDrafts] = useState<string[]>([]);
  const [keyLabel, setKeyLabel] = useState("");
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Reset editors when the selection moves.
  useEffect(() => {
    const current = state.objectives[selectedMonth] ?? [];
    setDrafts(Array.from({ length: MAX_OBJECTIVES }, (_, i) => current[i] ?? ""));
    setSavedNote(null);
  }, [selectedMonth]);
  useEffect(() => {
    setKeyLabel(state.keyDates[selected] ?? "");
  }, [selected]);

  const changeYear = (delta: number) => {
    const next = year + delta;
    setYear(next);
    setSelected(next === todayYear ? today : `${next}-01-01`);
  };

  const yearPrefix = `${year}-`;
  const wins = Object.values(state.days).filter((p) => p.date.startsWith(yearPrefix) && dayStatus(p) === "win").length;
  const keyCount = Object.keys(state.keyDates).filter((d) => d.startsWith(yearPrefix)).length;

  const plan = state.days[selected];
  const progress = dayProgress(plan);
  const monthIndex = Number(selectedMonth.slice(5, 7)) - 1;
  const monthName = formatMonthName(monthIndex);
  const savedKey = state.keyDates[selected] ?? "";

  return (
    <div className="layout warmap-layout">
      <section className="panel warmap" aria-labelledby="warmap-title">
        <div className="wm-head">
          <div className="wm-year">
            <button type="button" className="btn-icon" aria-label="Previous year" onClick={() => changeYear(-1)}>
              ‹
            </button>
            <h2 id="warmap-title">War Map {year}</h2>
            <button type="button" className="btn-icon" aria-label="Next year" onClick={() => changeYear(1)}>
              ›
            </button>
          </div>
          <p className="muted small" data-testid="wm-stats">
            {wins} winning {wins === 1 ? "day" : "days"} · {keyCount} key {keyCount === 1 ? "date" : "dates"}
          </p>
        </div>

        <ul className="wm-legend" aria-label="Legend">
          <li><span className="wm-swatch s-win" aria-hidden="true" />All done</li>
          <li><span className="wm-swatch s-partial" aria-hidden="true" />Some done</li>
          <li><span className="wm-swatch s-planned" aria-hidden="true" />Planned</li>
          <li><span className="wm-swatch has-key-swatch" aria-hidden="true" />Key date</li>
        </ul>

        <div className="wm-months">
          {Array.from({ length: 12 }, (_, m) => {
            const mk = monthKeyOf(year, m);
            const objectives = state.objectives[mk] ?? [];
            const offset = mondayOffset(year, m);
            const count = daysInMonth(year, m);
            return (
              <div key={mk} className={`wm-month ${mk === selectedMonth ? "is-selected" : ""}`}>
                <h3 className="wm-month-name">{formatMonthName(m, "short")}</h3>
                <div className="wm-grid" role="group" aria-label={`${formatMonthName(m)} ${year}`}>
                  {WEEKDAYS.map((d, i) => (
                    <span key={`h${i}`} className="wm-wd" aria-hidden="true">
                      {d}
                    </span>
                  ))}
                  {Array.from({ length: offset }, (_, i) => (
                    <span key={`b${i}`} aria-hidden="true" />
                  ))}
                  {Array.from({ length: count }, (_, i) => {
                    const key = toDateKey(new Date(year, m, i + 1));
                    const status = dayStatus(state.days[key]);
                    const label = state.keyDates[key];
                    const classes = [
                      "wm-day",
                      `s-${status}`,
                      key === today ? "is-today" : "",
                      key === selected ? "is-selected" : "",
                      label ? "has-key" : "",
                      key < today ? "is-past" : "",
                    ].join(" ");
                    return (
                      <button
                        key={key}
                        type="button"
                        className={classes}
                        aria-pressed={key === selected}
                        aria-label={`${formatDayLabel(key)}: ${STATUS_TEXT[status]}${label ? ` · ${label}` : ""}`}
                        title={label ?? undefined}
                        onClick={() => setSelected(key)}
                      >
                        {i + 1}
                      </button>
                    );
                  })}
                </div>
                {objectives.length > 0 && (
                  <ol className="wm-obj">
                    {objectives.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <aside className="side">
        <section className="panel wm-detail" aria-labelledby="wm-day-title">
          <h2 id="wm-day-title">{formatDayLabel(selected)}</h2>
          {progress.goalsTotal === 0 ? (
            <p className="muted">{selected === today ? "No goals planned yet today." : "No goals planned."}</p>
          ) : (
            <>
              <p className="muted" data-testid="wm-day-summary">
                {progress.goalsDone} of {progress.goalsTotal} goals done
              </p>
              <ul className="wm-day-goals">
                {plan!.goals.map((g) => (
                  <li key={g.id} className={isGoalDone(g) ? "is-done" : ""}>
                    <span aria-hidden="true">{isGoalDone(g) ? "✓" : "○"}</span> {g.title}
                  </li>
                ))}
              </ul>
            </>
          )}

          <form
            className="wm-key-form"
            onSubmit={(e) => {
              e.preventDefault();
              onSetKeyDate(selected, keyLabel);
            }}
          >
            <label htmlFor="key-date">Key date</label>
            <div className="add-goal-row">
              <input
                id="key-date"
                value={keyLabel}
                maxLength={MAX_KEY_DATE_LENGTH}
                placeholder="e.g. Launch, deadline, trip"
                onChange={(e) => setKeyLabel(e.target.value)}
              />
              <button type="submit" className="btn" disabled={keyLabel.trim() === savedKey}>
                Save
              </button>
            </div>
            {savedKey && (
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() => {
                  onSetKeyDate(selected, "");
                  setKeyLabel("");
                }}
              >
                Remove key date
              </button>
            )}
          </form>
        </section>

        <section className="panel wm-objectives" aria-labelledby="wm-obj-title">
          <h2 id="wm-obj-title">
            {monthName} objectives
          </h2>
          <p className="muted small">Up to {MAX_OBJECTIVES} things that would make this month a win.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSetObjectives(selectedMonth, drafts);
              setSavedNote("Saved");
            }}
          >
            {drafts.map((d, i) => (
              <input
                key={i}
                className="wm-obj-input"
                value={d}
                maxLength={MAX_TITLE_LENGTH}
                aria-label={`${monthName} objective ${i + 1}`}
                placeholder={`Objective ${i + 1}`}
                onChange={(e) => {
                  const next = [...drafts];
                  next[i] = e.target.value;
                  setDrafts(next);
                  setSavedNote(null);
                }}
              />
            ))}
            <div className="settings-actions">
              <button type="submit" className="btn btn-primary">
                Save objectives
              </button>
              {savedNote && (
                <span className="ok-text" role="status">
                  {savedNote}
                </span>
              )}
            </div>
          </form>
        </section>
      </aside>
    </div>
  );
}
