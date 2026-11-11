import { isGoalDone, trackedMs } from "./metrics";
import {
  MAX_ESTIMATE,
  MAX_GOALS,
  MAX_KEY_DATE_LENGTH,
  MAX_OBJECTIVES,
  MAX_TITLE_LENGTH,
  MIN_ESTIMATE,
  type AppState,
  type DateKey,
  type DayPlan,
  type Goal,
  type Subtask,
} from "./types";

export type Action =
  | { type: "addGoal"; date: DateKey; id: string; title: string }
  | { type: "renameGoal"; date: DateKey; goalId: string; title: string }
  | { type: "deleteGoal"; date: DateKey; goalId: string; now: number }
  | {
      type: "addSubtask";
      date: DateKey;
      goalId: string;
      id: string;
      title: string;
      estimateMin: number;
    }
  | { type: "renameSubtask"; date: DateKey; goalId: string; subtaskId: string; title: string }
  | {
      type: "setEstimate";
      date: DateKey;
      goalId: string;
      subtaskId: string;
      estimateMin: number;
    }
  | { type: "deleteSubtask"; date: DateKey; goalId: string; subtaskId: string }
  | { type: "toggleSubtask"; date: DateKey; goalId: string; subtaskId: string; now: number }
  | { type: "startTimer"; date: DateKey; goalId: string; subtaskId: string; now: number }
  | { type: "pauseTimers"; now: number }
  | { type: "carryOver"; from: DateKey; to: DateKey }
  | { type: "setObjectives"; month: string; objectives: string[] }
  | { type: "setKeyDate"; date: DateKey; label: string };

export function cleanTitle(raw: string, max = MAX_TITLE_LENGTH): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

export function clampEstimate(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_ESTIMATE;
  return Math.min(MAX_ESTIMATE, Math.max(MIN_ESTIMATE, Math.round(raw)));
}

function getDay(state: AppState, date: DateKey): DayPlan {
  return state.days[date] ?? { date, goals: [] };
}

function withDay(state: AppState, date: DateKey, fn: (plan: DayPlan) => DayPlan): AppState {
  const before = getDay(state, date);
  const after = fn(before);
  if (after === before) return state;
  return { ...state, days: { ...state.days, [date]: after } };
}

function withGoal(state: AppState, date: DateKey, goalId: string, fn: (goal: Goal) => Goal): AppState {
  return withDay(state, date, (plan) => {
    let changed = false;
    const goals = plan.goals.map((g) => {
      if (g.id !== goalId) return g;
      const next = fn(g);
      if (next !== g) changed = true;
      return next;
    });
    return changed ? { ...plan, goals } : plan;
  });
}

function withSubtask(
  state: AppState,
  date: DateKey,
  goalId: string,
  subtaskId: string,
  fn: (s: Subtask) => Subtask,
): AppState {
  return withGoal(state, date, goalId, (goal) => {
    let changed = false;
    const subtasks = goal.subtasks.map((s) => {
      if (s.id !== subtaskId) return s;
      const next = fn(s);
      if (next !== s) changed = true;
      return next;
    });
    return changed ? { ...goal, subtasks } : goal;
  });
}

/** Bank the elapsed time and stop the timer. */
function stopTimer(s: Subtask, now: number): Subtask {
  if (s.timerStartedAt === null) return s;
  return { ...s, trackedMs: trackedMs(s, now), timerStartedAt: null };
}

/** Stop every running timer on every day (only one should ever run). */
function pauseAll(state: AppState, now: number): AppState {
  let changed = false;
  const days: Record<DateKey, DayPlan> = {};
  for (const [key, plan] of Object.entries(state.days)) {
    let planChanged = false;
    const goals = plan.goals.map((g) => {
      if (!g.subtasks.some((s) => s.timerStartedAt !== null)) return g;
      planChanged = true;
      return { ...g, subtasks: g.subtasks.map((s) => stopTimer(s, now)) };
    });
    days[key] = planChanged ? { ...plan, goals } : plan;
    if (planChanged) changed = true;
  }
  return changed ? { ...state, days } : state;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "addGoal": {
      const title = cleanTitle(action.title);
      if (!title) return state;
      return withDay(state, action.date, (plan) => {
        if (plan.goals.length >= MAX_GOALS) return plan;
        if (plan.goals.some((g) => g.id === action.id)) return plan;
        return { ...plan, goals: [...plan.goals, { id: action.id, title, subtasks: [] }] };
      });
    }
    case "renameGoal": {
      const title = cleanTitle(action.title);
      if (!title) return state;
      return withGoal(state, action.date, action.goalId, (g) => (g.title === title ? g : { ...g, title }));
    }
    case "deleteGoal": {
      const paused = pauseAll(state, action.now);
      return withDay(paused, action.date, (plan) => {
        const goals = plan.goals.filter((g) => g.id !== action.goalId);
        return goals.length === plan.goals.length ? plan : { ...plan, goals };
      });
    }
    case "addSubtask": {
      const title = cleanTitle(action.title);
      if (!title) return state;
      return withGoal(state, action.date, action.goalId, (goal) => {
        if (goal.subtasks.some((s) => s.id === action.id)) return goal;
        const subtask: Subtask = {
          id: action.id,
          title,
          estimateMin: clampEstimate(action.estimateMin),
          done: false,
          completedAt: null,
          trackedMs: 0,
          timerStartedAt: null,
        };
        return { ...goal, subtasks: [...goal.subtasks, subtask] };
      });
    }
    case "renameSubtask": {
      const title = cleanTitle(action.title);
      if (!title) return state;
      return withSubtask(state, action.date, action.goalId, action.subtaskId, (s) =>
        s.title === title ? s : { ...s, title },
      );
    }
    case "setEstimate": {
      const estimateMin = clampEstimate(action.estimateMin);
      return withSubtask(state, action.date, action.goalId, action.subtaskId, (s) =>
        s.estimateMin === estimateMin ? s : { ...s, estimateMin },
      );
    }
    case "deleteSubtask":
      return withGoal(state, action.date, action.goalId, (goal) => {
        const subtasks = goal.subtasks.filter((s) => s.id !== action.subtaskId);
        return subtasks.length === goal.subtasks.length ? goal : { ...goal, subtasks };
      });
    case "toggleSubtask":
      return withSubtask(state, action.date, action.goalId, action.subtaskId, (s) => {
        if (s.done) return { ...s, done: false, completedAt: null };
        return { ...stopTimer(s, action.now), done: true, completedAt: action.now };
      });
    case "startTimer": {
      const target = getDay(state, action.date)
        .goals.find((g) => g.id === action.goalId)
        ?.subtasks.find((s) => s.id === action.subtaskId);
      if (!target || target.done || target.timerStartedAt !== null) return state;
      const paused = pauseAll(state, action.now);
      return withSubtask(paused, action.date, action.goalId, action.subtaskId, (s) => ({
        ...s,
        timerStartedAt: action.now,
      }));
    }
    case "pauseTimers":
      return pauseAll(state, action.now);
    case "carryOver": {
      if (action.from === action.to) return state;
      const source = state.days[action.from];
      if (!source) return state;
      return withDay(state, action.to, (plan) => {
        const existing = new Set(plan.goals.map((g) => g.id));
        const carried: Goal[] = [];
        for (const goal of source.goals) {
          if (plan.goals.length + carried.length >= MAX_GOALS) break;
          if (existing.has(goal.id) || isGoalDone(goal)) continue;
          carried.push({
            id: goal.id,
            title: goal.title,
            subtasks: goal.subtasks
              .filter((s) => !s.done)
              .map((s) => ({ ...s, trackedMs: 0, timerStartedAt: null, completedAt: null })),
          });
        }
        return carried.length === 0 ? plan : { ...plan, goals: [...plan.goals, ...carried] };
      });
    }
    case "setObjectives": {
      const cleaned = action.objectives.map((o) => cleanTitle(o)).filter(Boolean).slice(0, MAX_OBJECTIVES);
      const objectives = { ...state.objectives };
      if (cleaned.length === 0) delete objectives[action.month];
      else objectives[action.month] = cleaned;
      return { ...state, objectives };
    }
    case "setKeyDate": {
      const label = cleanTitle(action.label, MAX_KEY_DATE_LENGTH);
      const keyDates = { ...state.keyDates };
      if (!label) delete keyDates[action.date];
      else keyDates[action.date] = label;
      return { ...state, keyDates };
    }
  }
}

/** Goals from an earlier day that could be brought forward to `to`. */
export function carryOverCandidates(state: AppState, from: DateKey | null, to: DateKey): Goal[] {
  if (!from) return [];
  const source = state.days[from];
  if (!source) return [];
  const present = new Set((state.days[to]?.goals ?? []).map((g) => g.id));
  return source.goals.filter((g) => !present.has(g.id) && !isGoalDone(g));
}

/** Most recent day before `today` that had goals. */
export function previousPlannedDay(state: AppState, today: DateKey): DateKey | null {
  let best: DateKey | null = null;
  for (const plan of Object.values(state.days)) {
    if (plan.date < today && plan.goals.length > 0 && (best === null || plan.date > best)) best = plan.date;
  }
  return best;
}
