import type { AppState, DateKey, DayPlan, Goal, Subtask } from "../domain/types";

let counter = 0;
export const uid = (prefix = "id") => `${prefix}-${++counter}`;

export function subtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: uid("s"),
    title: "Step",
    estimateMin: 25,
    done: false,
    completedAt: null,
    trackedMs: 0,
    timerStartedAt: null,
    ...overrides,
  };
}

export function goal(overrides: Partial<Goal> = {}): Goal {
  return { id: uid("g"), title: "Goal", subtasks: [], ...overrides };
}

export function day(date: DateKey, goals: Goal[]): DayPlan {
  return { date, goals };
}

export function stateOf(...plans: DayPlan[]): AppState {
  return { version: 1, days: Object.fromEntries(plans.map((p) => [p.date, p])), objectives: {}, keyDates: {} };
}

/** A past day where one goal had a single finished, untimed subtask of `minutes`. */
export function workedDay(date: DateKey, minutes: number, allDone = true): DayPlan {
  const subtasks = [subtask({ estimateMin: minutes, done: true, completedAt: 1 })];
  if (!allDone) subtasks.push(subtask({ estimateMin: 10 }));
  return day(date, [goal({ subtasks })]);
}
