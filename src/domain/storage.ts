import { DATE_KEY_PATTERN, MONTH_KEY_PATTERN } from "./dates";
import { emptyState, MAX_GOALS, MAX_OBJECTIVES, type AppState, type DayPlan, type Goal, type Subtask } from "./types";

/** Everything lives on this device, in the app's own WebView storage. Nothing is sent anywhere. */
export const STORAGE_KEY = "momentum:v1";
export const CORRUPT_KEY_PREFIX = "momentum:corrupt:";

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNullableNumber = (x: unknown): x is number | null => x === null || isFiniteNumber(x);

function isSubtask(x: unknown): x is Subtask {
  return (
    isObject(x) &&
    typeof x.id === "string" &&
    typeof x.title === "string" &&
    isFiniteNumber(x.estimateMin) &&
    typeof x.done === "boolean" &&
    isNullableNumber(x.completedAt) &&
    isFiniteNumber(x.trackedMs) &&
    x.trackedMs >= 0 &&
    isNullableNumber(x.timerStartedAt)
  );
}

function isGoal(x: unknown): x is Goal {
  return (
    isObject(x) &&
    typeof x.id === "string" &&
    typeof x.title === "string" &&
    Array.isArray(x.subtasks) &&
    x.subtasks.every(isSubtask)
  );
}

function isDayPlan(key: string, x: unknown): x is DayPlan {
  return (
    isObject(x) &&
    x.date === key &&
    DATE_KEY_PATTERN.test(key) &&
    Array.isArray(x.goals) &&
    x.goals.length <= MAX_GOALS &&
    x.goals.every(isGoal)
  );
}

function isObjectives(x: unknown): boolean {
  return (
    isObject(x) &&
    Object.entries(x).every(
      ([key, list]) =>
        MONTH_KEY_PATTERN.test(key) &&
        Array.isArray(list) &&
        list.length <= MAX_OBJECTIVES &&
        list.every((o) => typeof o === "string"),
    )
  );
}

function isKeyDates(x: unknown): boolean {
  return isObject(x) && Object.entries(x).every(([key, label]) => DATE_KEY_PATTERN.test(key) && typeof label === "string");
}

/** Saved state. `objectives`/`keyDates` were added later, so older saves may lack them. */
type StoredState = Omit<AppState, "objectives" | "keyDates"> & Partial<Pick<AppState, "objectives" | "keyDates">>;

export function isAppState(x: unknown): x is StoredState {
  if (!isObject(x) || x.version !== 1 || !isObject(x.days)) return false;
  if (x.objectives !== undefined && !isObjectives(x.objectives)) return false;
  if (x.keyDates !== undefined && !isKeyDates(x.keyDates)) return false;
  return Object.entries(x.days).every(([key, plan]) => isDayPlan(key, plan));
}

function normalize(s: StoredState): AppState {
  return { version: 1, days: s.days, objectives: s.objectives ?? {}, keyDates: s.keyDates ?? {} };
}

export interface LoadResult {
  state: AppState;
  /** Saved data was unreadable; a copy was set aside and a fresh start was made. */
  recovered: boolean;
}

function defaultStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadState(store: KeyValueStore | null = defaultStore(), now = Date.now()): LoadResult {
  if (!store) return { state: emptyState(), recovered: false };
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { state: emptyState(), recovered: false };
  }
  if (raw === null) return { state: emptyState(), recovered: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isAppState(parsed)) return { state: normalize(parsed), recovered: false };
  } catch {
    // fall through to recovery
  }
  try {
    store.setItem(`${CORRUPT_KEY_PREFIX}${now}`, raw);
  } catch {
    // Best effort: never block the app on the backup.
  }
  return { state: emptyState(), recovered: true };
}

/** Returns false if the write failed (e.g. storage full or unavailable). */
export function saveState(state: AppState, store: KeyValueStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
