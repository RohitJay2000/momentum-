import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { ActivityPanel } from "./components/ActivityPanel";
import { CapacityPanel } from "./components/CapacityPanel";
import { GoalCard, type GoalHandlers } from "./components/GoalCard";
import { GuardSettings } from "./components/GuardSettings";
import { InterruptDialog, type Interrupt } from "./components/Interrupts";
import { MonthFocus } from "./components/MonthFocus";
import { WarMap } from "./components/WarMap";
import { formatDayLabel, toDateKey } from "./domain/dates";
import {
  computeCapacity,
  currentRun,
  dayPlannedMinutes,
  dayProgress,
  dayWorkMinutes,
  nextStep,
  totalAllInDays,
} from "./domain/metrics";
import { carryOverCandidates, previousPlannedDay, reducer, type Action } from "./domain/reducer";
import { loadState, saveState } from "./domain/storage";
import { MAX_GOALS, MAX_TITLE_LENGTH, type AppState, type Goal, type Subtask } from "./domain/types";
import { defaultApi, type NativeApi } from "./platform/native";
import { useTracker } from "./platform/useTracker";

export interface AppProps {
  /** Injectable clock for tests. */
  clock?: () => number;
  /** Injectable id generator for tests. */
  makeId?: () => string;
  initialState?: AppState;
  /** Mac app bridge; defaults to the real one inside the app and a no-op in a browser. */
  api?: NativeApi;
}

/** The step whose focus timer is running, if any (only one runs at a time). */
export function runningStep(state: AppState): { goal: Goal; subtask: Subtask } | null {
  for (const plan of Object.values(state.days)) {
    for (const goal of plan.goals) {
      const subtask = goal.subtasks.find((s) => s.timerStartedAt !== null);
      if (subtask) return { goal, subtask };
    }
  }
  return null;
}

const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function defaultId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function momentumMessage(done: number, total: number, goalsTotal: number, allDone: boolean): string {
  if (goalsTotal === 0) return "Pick 2–3 non-negotiables that would make today a win.";
  if (allDone) return "Every non-negotiable is done. Today is a win — anything more is bonus.";
  if (total === 0) return "Now break each goal into small steps.";
  if (done === 0) return "Start with the smallest step. Momentum comes after starting.";
  return `${done} ${done === 1 ? "step" : "steps"} done — keep the chain going.`;
}

export function App({ clock = Date.now, makeId = defaultId, initialState, api: apiProp }: AppProps) {
  const [api] = useState(() => apiProp ?? defaultApi());
  const [initial] = useState(() =>
    initialState ? { state: initialState, recovered: false } : loadState(),
  );
  const recovered = initial.recovered;
  const [saveFailed, setSaveFailed] = useState(false);
  const [state, rawDispatch] = useReducer(reducer, initial.state);
  const [now, setNow] = useState(clock);
  const [dismissedCarry, setDismissedCarry] = useState<string | null>(null);
  const [view, setView] = useState<"today" | "warmap">("today");
  const [interrupt, setInterrupt] = useState<Interrupt | null>(null);
  const [idlePausedAt, setIdlePausedAt] = useState<number | null>(null);
  const [trackerWriteError, setTrackerWriteError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const today = toDateKey(new Date(now));
  const plan = state.days[today];
  const anyRunning = useMemo(
    () =>
      Object.values(state.days).some((p) =>
        p.goals.some((g) => g.subtasks.some((s) => s.timerStartedAt !== null)),
      ),
    [state],
  );

  // Tick every second while a timer runs; otherwise just keep the date fresh.
  useEffect(() => {
    const id = window.setInterval(() => setNow(clock()), anyRunning ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [anyRunning, clock]);

  useEffect(() => {
    setSaveFailed(!saveState(state));
  }, [state]);

  const dispatch = useCallback(
    (action: Action) => {
      rawDispatch(action);
      setNow(clock());
    },
    [clock],
  );

  const tracker = useTracker(api, today);

  // Tell the Mac guard when a focus session (a running step timer) starts or stops.
  const running = runningStep(state);
  const focusLabel = running ? running.subtask.title : null;
  useEffect(() => {
    api.setFocus(focusLabel !== null, focusLabel).catch(() => undefined);
  }, [api, focusLabel]);

  // Events from the background tracker.
  useEffect(() => {
    let disposed = false;
    const offs: (() => void)[] = [];
    const add = (p: Promise<() => void>) =>
      p
        .then((off) => (disposed ? off() : offs.push(off)))
        .catch(() => undefined);
    add(api.onDistraction((event) => setInterrupt({ kind: "distraction", event })));
    add(api.onBreak((event) => setInterrupt({ kind: "break", event })));
    add(
      api.onIdle(({ sinceMs }) => {
        const active = runningStep(stateRef.current);
        if (!active || active.subtask.timerStartedAt === null) return;
        // Away time isn't real work: stop the clock back when input stopped.
        dispatch({ type: "pauseTimers", now: Math.max(sinceMs, active.subtask.timerStartedAt) });
        setIdlePausedAt(sinceMs);
      }),
    );
    add(api.onStorageError((message) => setTrackerWriteError(message)));
    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [api, dispatch]);

  const stamp = () => clock();
  const handlers: GoalHandlers = {
    onRenameGoal: (goalId, title) => dispatch({ type: "renameGoal", date: today, goalId, title }),
    onDeleteGoal: (goalId) => dispatch({ type: "deleteGoal", date: today, goalId, now: stamp() }),
    onAddSubtask: (goalId, title, estimateMin) =>
      dispatch({ type: "addSubtask", date: today, goalId, id: makeId(), title, estimateMin }),
    onToggle: (goalId, subtaskId) =>
      dispatch({ type: "toggleSubtask", date: today, goalId, subtaskId, now: stamp() }),
    onStart: (goalId, subtaskId) =>
      dispatch({ type: "startTimer", date: today, goalId, subtaskId, now: stamp() }),
    onPause: () => dispatch({ type: "pauseTimers", now: stamp() }),
    onRenameSubtask: (goalId, subtaskId, title) =>
      dispatch({ type: "renameSubtask", date: today, goalId, subtaskId, title }),
    onEstimate: (goalId, subtaskId, estimateMin) =>
      dispatch({ type: "setEstimate", date: today, goalId, subtaskId, estimateMin }),
    onDeleteSubtask: (goalId, subtaskId) =>
      dispatch({ type: "deleteSubtask", date: today, goalId, subtaskId }),
  };

  const [goalTitle, setGoalTitle] = useState("");
  const goals = plan?.goals ?? [];
  const canAddGoal = goals.length < MAX_GOALS;
  const addGoal = (e: FormEvent) => {
    e.preventDefault();
    if (!goalTitle.trim() || !canAddGoal) return;
    dispatch({ type: "addGoal", date: today, id: makeId(), title: goalTitle });
    setGoalTitle("");
  };

  const progress = dayProgress(plan);
  const next = nextStep(plan);
  const run = currentRun(state, today);
  const allIn = totalAllInDays(state);
  const capacity = useMemo(() => computeCapacity(state, today, now), [state, today, now]);
  const workToday = dayWorkMinutes(plan, now);
  const plannedToday = dayPlannedMinutes(plan, now);
  const pct = progress.subtasksTotal === 0 ? 0 : Math.round((progress.subtasksDone / progress.subtasksTotal) * 100);

  const prevDay = previousPlannedDay(state, today);
  const carry = canAddGoal ? carryOverCandidates(state, prevDay, today) : [];
  const carryKey = `${prevDay}->${today}`;
  const showCarry = carry.length > 0 && dismissedCarry !== carryKey;
  const carryCount = Math.min(carry.length, MAX_GOALS - goals.length);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <h1>Momentum</h1>
        </div>
        <nav className="tabs" aria-label="Views">
          <button type="button" className="tab" aria-pressed={view === "today"} onClick={() => setView("today")}>
            Today
          </button>
          <button type="button" className="tab" aria-pressed={view === "warmap"} onClick={() => setView("warmap")}>
            War Map
          </button>
        </nav>
        <div className="topbar-meta">
          <span className="date">{formatDayLabel(today)}</span>
          {run > 0 && (
            <span className="chip chip-run" title="Consecutive days with every non-negotiable done">
              {run}-day run
            </span>
          )}
          {allIn > run && <span className="chip">{allIn} winning {allIn === 1 ? "day" : "days"}</span>}
        </div>
      </header>

      {recovered && (
        <p className="banner banner-warn" role="alert">
          Your saved data couldn't be read, so Momentum started fresh. A copy of the old data was kept on this Mac.
        </p>
      )}
      {idlePausedAt !== null && (
        <div className="banner banner-info" role="status">
          <span>You stepped away at {timeOfDay(idlePausedAt)}, so your focus timer was paused there.</span>
          <button type="button" className="btn btn-ghost" onClick={() => setIdlePausedAt(null)}>
            OK
          </button>
        </div>
      )}
      {trackerWriteError && (
        <p className="banner banner-warn" role="alert">
          Activity couldn't be saved on this Mac: {trackerWriteError}
        </p>
      )}
      {saveFailed && (
        <p className="banner banner-warn" role="alert">
          Couldn't save your latest changes on this Mac. Keep the app open and try again.
        </p>
      )}

      {view === "warmap" ? (
        <main>
          <WarMap
            state={state}
            today={today}
            onSetObjectives={(month, objectives) => dispatch({ type: "setObjectives", month, objectives })}
            onSetKeyDate={(date, label) => dispatch({ type: "setKeyDate", date, label })}
          />
        </main>
      ) : (
        <main className="layout">
          <section className="today" aria-labelledby="today-title">
            <MonthFocus state={state} today={today} onOpenWarMap={() => setView("warmap")} />
            <div className={`panel momentum ${progress.allGoalsDone ? "is-win" : ""}`}>
              <div className="momentum-row">
                <h2 id="today-title">Today's non-negotiables</h2>
                <span className="momentum-count" data-testid="goals-count">
                  {progress.goalsDone}/{progress.goalsTotal} goals
                </span>
              </div>
              <div
                className="progress progress-lg"
                role="progressbar"
                aria-label="Today's progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="momentum-msg" data-testid="momentum-msg">
                {momentumMessage(progress.subtasksDone, progress.subtasksTotal, progress.goalsTotal, progress.allGoalsDone)}
              </p>
              {next && (
                <div className="up-next">
                  <span className="muted">Up next</span>
                  <strong data-testid="up-next">{next.subtask.title}</strong>
                  <span className="muted">for “{next.goal.title}”</span>
                  {next.subtask.timerStartedAt === null && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handlers.onStart(next.goal.id, next.subtask.id)}
                    >
                      Start it
                    </button>
                  )}
                </div>
              )}
            </div>

            {showCarry && prevDay && (
              <div className="panel carry" role="region" aria-label="Unfinished goals">
                <p>
                  {carry.length} unfinished {carry.length === 1 ? "goal" : "goals"} from {formatDayLabel(prevDay)}.
                </p>
                <div className="carry-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => dispatch({ type: "carryOver", from: prevDay, to: today })}
                  >
                    Bring {carryCount === 1 ? "it" : `${carryCount}`} forward
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setDismissedCarry(carryKey)}>
                    Start fresh
                  </button>
                </div>
              </div>
            )}

            {goals.length > 0 && (
              <div className="goals">
                {goals.map((goal, i) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    index={i}
                    now={now}
                    nextSubtaskId={next?.subtask.id ?? null}
                    {...handlers}
                  />
                ))}
              </div>
            )}

            {canAddGoal ? (
              <form className="panel add-goal" onSubmit={addGoal}>
                <label htmlFor="new-goal">
                  {goals.length === 0 ? "What absolutely has to get done today?" : "Add another non-negotiable"}
                  <span className="muted"> ({goals.length}/{MAX_GOALS})</span>
                </label>
                <div className="add-goal-row">
                  <input
                    id="new-goal"
                    value={goalTitle}
                    onChange={(e) => setGoalTitle(e.target.value)}
                    placeholder="e.g. Ship the onboarding email"
                    maxLength={MAX_TITLE_LENGTH}
                  />
                  <button type="submit" className="btn btn-primary" disabled={!goalTitle.trim()}>
                    Add goal
                  </button>
                </div>
              </form>
            ) : (
              <p className="panel full-note" data-testid="max-goals-note">
                That's {MAX_GOALS} — your max. Protecting your focus is the point.
              </p>
            )}
          </section>

          <aside className="side">
            <CapacityPanel
              capacity={capacity}
              today={today}
              todayWorkMinutes={workToday}
              todayPlannedMinutes={plannedToday}
            />
            <ActivityPanel api={api} tracker={tracker} />
            <GuardSettings api={api} tracker={tracker} />
            <p className="privacy muted">🔒 Everything stays on this Mac. No account, no cloud, nothing sent anywhere.</p>
          </aside>
        </main>
      )}

      {interrupt && (
        <InterruptDialog
          interrupt={interrupt}
          onBackToWork={() => setInterrupt(null)}
          onSnooze={() => {
            api.snoozeGuard(5).catch(() => undefined);
            setInterrupt(null);
          }}
          onTakeBreak={() => {
            dispatch({ type: "pauseTimers", now: stamp() });
            api.takeBreak().catch(() => undefined);
            setInterrupt(null);
          }}
          onKeepGoing={() => setInterrupt(null)}
        />
      )}
    </div>
  );
}
