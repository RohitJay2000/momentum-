import { day, goal, stateOf, subtask } from "../test/factories";
import { addDays, formatDayLabel, toDateKey } from "./dates";
import { formatClock, formatMinutes } from "./format";
import { CORRUPT_KEY_PREFIX, isAppState, loadState, saveState, STORAGE_KEY } from "./storage";
import { emptyState } from "./types";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("storage", () => {
  it("round-trips state", () => {
    const store = memoryStore();
    const state = stateOf(day("2026-11-04", [goal({ subtasks: [subtask({ timerStartedAt: 5 })] })]));
    expect(saveState(state, store)).toBe(true);
    expect(loadState(store)).toEqual({ state, recovered: false });
  });

  it("starts empty when nothing is saved or storage is unavailable", () => {
    expect(loadState(memoryStore())).toEqual({ state: emptyState(), recovered: false });
    expect(loadState(null)).toEqual({ state: emptyState(), recovered: false });
    expect(saveState(emptyState(), null)).toBe(false);
  });

  it("backs up unreadable data and starts fresh", () => {
    const store = memoryStore({ [STORAGE_KEY]: "{not json" });
    expect(loadState(store, 42)).toEqual({ state: emptyState(), recovered: true });
    expect(store.data.get(`${CORRUPT_KEY_PREFIX}42`)).toBe("{not json");
  });

  it("rejects structurally invalid data", () => {
    const bad = [
      null,
      [],
      { version: 2, days: {} },
      { version: 1, days: [] },
      { version: 1, days: { "2026-11-04": { date: "2026-11-05", goals: [] } } },
      { version: 1, days: { nope: { date: "nope", goals: [] } } },
      { version: 1, days: { "2026-11-04": { date: "2026-11-04", goals: [{ id: 1, title: "x", subtasks: [] }] } } },
      {
        version: 1,
        days: {
          "2026-11-04": {
            date: "2026-11-04",
            goals: [{ id: "g", title: "x", subtasks: [{ ...subtask(), trackedMs: -1 }] }],
          },
        },
      },
      {
        version: 1,
        days: { "2026-11-04": { date: "2026-11-04", goals: [goal(), goal(), goal(), goal()] } },
      },
    ];
    for (const b of bad) expect(isAppState(b)).toBe(false);
    const store = memoryStore({ [STORAGE_KEY]: JSON.stringify({ version: 1, days: [] }) });
    expect(loadState(store).recovered).toBe(true);
  });

  it("reports failed writes instead of throwing", () => {
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(saveState(emptyState(), store)).toBe(false);
    const throwingRead = { getItem: () => { throw new Error("denied"); }, setItem: () => undefined };
    expect(loadState(throwingRead)).toEqual({ state: emptyState(), recovered: false });
  });
});

describe("dates and formatting", () => {
  it("uses local calendar days and shifts across months and years", () => {
    expect(toDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-11-01", 7)).toBe("2026-11-08");
    expect(formatDayLabel("2026-11-04")).toBe("Wednesday, Nov 4");
  });

  it("formats minutes and clocks", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(95)).toBe("1h 35m");
    expect(formatMinutes(-5)).toBe("0m");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(247_000)).toBe("4:07");
    expect(formatClock(3_729_000)).toBe("1:02:09");
  });
});
