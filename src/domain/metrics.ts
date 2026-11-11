import { addDays, daysBetween } from "./dates";
import { MAX_TIMER_RUN_MS, type AppState, type DateKey, type DayPlan, type Goal, type Subtask } from "./types";

// ---------- Real work ----------

/** Banked time plus the live portion of a running timer (capped so a forgotten timer can't inflate history). */
export function trackedMs(subtask: Subtask, now: number): number {
  const live =
    subtask.timerStartedAt === null
      ? 0
      : Math.min(MAX_TIMER_RUN_MS, Math.max(0, now - subtask.timerStartedAt));
  return subtask.trackedMs + live;
}

export function isTimerRunning(subtask: Subtask): boolean {
  return subtask.timerStartedAt !== null;
}

/**
 * Minutes of real work a subtask contributes.
 * - Timed work counts its real tracked time (whole minutes).
 * - A finished subtask with under a minute on the clock counts its estimate.
 */
export function subtaskWorkMinutes(subtask: Subtask, now: number): number {
  const tracked = trackedMs(subtask, now) / 60_000;
  if (subtask.done) return tracked >= 1 ? Math.round(tracked) : subtask.estimateMin;
  return Math.floor(tracked);
}

/** What the day is asking of you: real work on finished items, the larger of estimate/tracked otherwise. */
export function subtaskPlannedMinutes(subtask: Subtask, now: number): number {
  if (subtask.done) return subtaskWorkMinutes(subtask, now);
  return Math.max(subtask.estimateMin, Math.floor(trackedMs(subtask, now) / 60_000));
}

export function dayWorkMinutes(plan: DayPlan | undefined, now: number): number {
  if (!plan) return 0;
  return sumSubtasks(plan, (s) => subtaskWorkMinutes(s, now));
}

export function dayPlannedMinutes(plan: DayPlan | undefined, now: number): number {
  if (!plan) return 0;
  return sumSubtasks(plan, (s) => subtaskPlannedMinutes(s, now));
}

function sumSubtasks(plan: DayPlan, fn: (s: Subtask) => number): number {
  let total = 0;
  for (const goal of plan.goals) for (const s of goal.subtasks) total += fn(s);
  return total;
}

// ---------- Progress & momentum ----------

export function isGoalDone(goal: Goal): boolean {
  return goal.subtasks.length > 0 && goal.subtasks.every((s) => s.done);
}

export interface DayProgress {
  subtasksDone: number;
  subtasksTotal: number;
  goalsDone: number;
  goalsTotal: number;
  /** Every non-negotiable is finished (and there was at least one). */
  allGoalsDone: boolean;
}

export function dayProgress(plan: DayPlan | undefined): DayProgress {
  const goals = plan?.goals ?? [];
  let subtasksDone = 0;
  let subtasksTotal = 0;
  let goalsDone = 0;
  for (const goal of goals) {
    subtasksTotal += goal.subtasks.length;
    subtasksDone += goal.subtasks.filter((s) => s.done).length;
    if (isGoalDone(goal)) goalsDone += 1;
  }
  return {
    subtasksDone,
    subtasksTotal,
    goalsDone,
    goalsTotal: goals.length,
    allGoalsDone: goals.length > 0 && goalsDone === goals.length,
  };
}

export function hasAnySubtask(plan: DayPlan | undefined): boolean {
  return !!plan && plan.goals.some((g) => g.subtasks.length > 0);
}

/**
 * Consecutive "all non-negotiables done" days. Today counts once it's complete;
 * an unfinished today doesn't break a run that ended yesterday.
 */
export function currentRun(state: AppState, today: DateKey): number {
  let run = 0;
  let cursor = today;
  if (!dayProgress(state.days[today]).allGoalsDone) cursor = addDays(today, -1);
  while (dayProgress(state.days[cursor]).allGoalsDone) {
    run += 1;
    cursor = addDays(cursor, -1);
  }
  return run;
}

export function totalAllInDays(state: AppState): number {
  return Object.values(state.days).filter((p) => dayProgress(p).allGoalsDone).length;
}

/** How a day looks on the War Map. */
export type DayStatus = "none" | "planned" | "partial" | "win";

export function dayStatus(plan: DayPlan | undefined): DayStatus {
  const p = dayProgress(plan);
  if (p.goalsTotal === 0) return "none";
  if (p.allGoalsDone) return "win";
  if (p.subtasksDone > 0 || p.goalsDone > 0) return "partial";
  return "planned";
}

export interface UpcomingDate {
  date: DateKey;
  label: string;
  daysAway: number;
}

/** Key dates from today on, soonest first. */
export function upcomingKeyDates(state: AppState, today: DateKey, limit = 3): UpcomingDate[] {
  return Object.entries(state.keyDates)
    .filter(([date]) => date >= today)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, limit)
    .map(([date, label]) => ({ date, label, daysAway: daysBetween(today, date) }));
}

export interface NextStep {
  goal: Goal;
  subtask: Subtask;
}

/** The single next tiny step: first open subtask of the first unfinished goal. */
export function nextStep(plan: DayPlan | undefined): NextStep | null {
  for (const goal of plan?.goals ?? []) {
    const subtask = goal.subtasks.find((s) => !s.done);
    if (subtask) return { goal, subtask };
  }
  return null;
}

// ---------- Consistent capacity ----------

/** Look at up to this many recent days that had a plan. */
export const CAPACITY_WINDOW_DAYS = 14;
/** Days of history needed before giving a number. */
export const CAPACITY_MIN_DAYS = 5;
/** Capacity = the amount you reached on at least this share of recent days. */
export const CAPACITY_CONSISTENCY = 0.8;
/** Warn when today's plan exceeds capacity by more than this factor. */
export const OVERPLAN_FACTOR = 1.15;
/** Days in a row of finishing everything (at/above capacity) before suggesting a stretch. */
export const STRETCH_STREAK = 5;
export const STRETCH_FACTOR = 1.1;

export interface HistoryDay {
  date: DateKey;
  workMinutes: number;
  allGoalsDone: boolean;
}

export type Capacity =
  | { status: "calibrating"; daysLogged: number; daysNeeded: number; history: HistoryDay[] }
  | {
      status: "ready";
      /** Real work you reached on at least 80% of recent days, rounded down to 5 minutes. */
      consistentMinutes: number;
      averageMinutes: number;
      bestMinutes: number;
      daysUsed: number;
      /** Recent days show you're finishing everything; a small stretch is reasonable. */
      stretchMinutes: number | null;
      history: HistoryDay[];
    };

const roundDown5 = (n: number) => Math.floor(n / 5) * 5;
const roundNearest5 = (n: number) => Math.round(n / 5) * 5;

/** Nearest-rank percentile: the value at least (1 - p) of samples meet or exceed. */
export function lowerPercentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((1 - share) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

/** Past days (before today) that had subtasks planned, most recent first. */
export function recentHistory(state: AppState, today: DateKey, now: number): HistoryDay[] {
  return Object.values(state.days)
    .filter((p) => p.date < today && hasAnySubtask(p))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, CAPACITY_WINDOW_DAYS)
    .map((p) => ({
      date: p.date,
      workMinutes: dayWorkMinutes(p, now),
      allGoalsDone: dayProgress(p).allGoalsDone,
    }));
}

export function computeCapacity(state: AppState, today: DateKey, now: number): Capacity {
  const history = recentHistory(state, today, now);
  if (history.length < CAPACITY_MIN_DAYS) {
    return {
      status: "calibrating",
      daysLogged: history.length,
      daysNeeded: CAPACITY_MIN_DAYS,
      history,
    };
  }
  const minutes = history.map((d) => d.workMinutes);
  const consistentMinutes = roundDown5(lowerPercentile(minutes, CAPACITY_CONSISTENCY));
  const averageMinutes = Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length);
  const bestMinutes = Math.max(...minutes);

  const lastFew = history.slice(0, STRETCH_STREAK);
  const finishingEverything =
    consistentMinutes > 0 &&
    lastFew.length === STRETCH_STREAK &&
    lastFew.every((d) => d.allGoalsDone && d.workMinutes >= consistentMinutes);
  const stretchMinutes = finishingEverything
    ? Math.max(consistentMinutes + 5, roundNearest5(consistentMinutes * STRETCH_FACTOR))
    : null;

  return {
    status: "ready",
    consistentMinutes,
    averageMinutes,
    bestMinutes,
    daysUsed: history.length,
    stretchMinutes,
    history,
  };
}

export type PlanCheck =
  | { kind: "unknown" }
  | { kind: "ok"; plannedMinutes: number; capacityMinutes: number }
  | { kind: "over"; plannedMinutes: number; capacityMinutes: number; overByMinutes: number };

/** Compare today's plan with your consistent capacity. */
export function checkPlan(capacity: Capacity, plannedMinutes: number): PlanCheck {
  if (capacity.status !== "ready" || capacity.consistentMinutes <= 0) return { kind: "unknown" };
  const capacityMinutes = capacity.stretchMinutes ?? capacity.consistentMinutes;
  // Round the threshold: 100 * 1.15 is 114.99999999999999 in floating point.
  if (plannedMinutes > Math.round(capacityMinutes * OVERPLAN_FACTOR)) {
    return {
      kind: "over",
      plannedMinutes,
      capacityMinutes,
      overByMinutes: plannedMinutes - capacityMinutes,
    };
  }
  return { kind: "ok", plannedMinutes, capacityMinutes };
}
