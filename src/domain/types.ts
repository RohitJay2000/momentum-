/** Local calendar day in `YYYY-MM-DD` form. */
export type DateKey = string;

export interface Subtask {
  id: string;
  title: string;
  /** Planned effort in minutes. */
  estimateMin: number;
  done: boolean;
  completedAt: number | null;
  /** Focus-timer time already banked (milliseconds). */
  trackedMs: number;
  /** Epoch ms when the focus timer was started, or null when not running. */
  timerStartedAt: number | null;
}

export interface Goal {
  id: string;
  title: string;
  subtasks: Subtask[];
}

export interface DayPlan {
  date: DateKey;
  goals: Goal[];
}

/** Calendar month in `YYYY-MM` form. */
export type MonthKey = string;

export interface AppState {
  version: 1;
  days: Record<DateKey, DayPlan>;
  /** War Map: up to 3 main objectives per month. */
  objectives: Record<MonthKey, string[]>;
  /** War Map: one short label per important date (deadline, launch, trip…). */
  keyDates: Record<DateKey, string>;
}

export const MAX_OBJECTIVES = 3;
export const MAX_KEY_DATE_LENGTH = 80;

/** Non-negotiables per day. Two or three is the sweet spot; more dilutes focus. */
export const MAX_GOALS = 3;
export const MAX_TITLE_LENGTH = 200;
export const MIN_ESTIMATE = 1;
export const MAX_ESTIMATE = 480;
export const DEFAULT_ESTIMATE = 25;
export const ESTIMATE_OPTIONS = [5, 10, 15, 25, 45, 60, 90, 120] as const;
/** A single forgotten timer run never counts for more than this. */
export const MAX_TIMER_RUN_MS = 3 * 60 * 60 * 1000;

export function emptyState(): AppState {
  return { version: 1, days: {}, objectives: {}, keyDates: {} };
}
