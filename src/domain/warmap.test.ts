import { day, goal, stateOf, subtask } from "../test/factories";
import { daysBetween, daysInMonth, mondayOffset, monthKeyOf, toMonthKey } from "./dates";
import { dayStatus, upcomingKeyDates } from "./metrics";
import { reducer } from "./reducer";
import { isAppState, loadState, STORAGE_KEY } from "./storage";
import { emptyState, MAX_KEY_DATE_LENGTH } from "./types";

const D = "2026-11-04";

describe("war map day status", () => {
  it("classifies days without shaming", () => {
    expect(dayStatus(undefined)).toBe("none");
    expect(dayStatus(day(D, []))).toBe("none");
    expect(dayStatus(day(D, [goal({ subtasks: [subtask()] })]))).toBe("planned");
    expect(dayStatus(day(D, [goal()]))).toBe("planned");
    expect(dayStatus(day(D, [goal({ subtasks: [subtask({ done: true }), subtask()] })]))).toBe("partial");
    expect(
      dayStatus(day(D, [goal({ subtasks: [subtask({ done: true })] }), goal({ subtasks: [subtask()] })])),
    ).toBe("partial");
    expect(dayStatus(day(D, [goal({ subtasks: [subtask({ done: true })] })]))).toBe("win");
  });
});

describe("calendar helpers", () => {
  it("counts days and lays out Monday-first months", () => {
    expect(daysBetween("2026-11-04", "2026-11-16")).toBe(12);
    expect(daysBetween("2026-11-04", "2026-11-04")).toBe(0);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // across a DST change
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2026, 11)).toBe(31);
    expect(mondayOffset(2026, 10)).toBe(6); // Nov 1, 2026 is a Sunday
    expect(mondayOffset(2026, 5)).toBe(0); // Jun 1, 2026 is a Monday
    expect(monthKeyOf(2026, 0)).toBe("2026-01");
    expect(toMonthKey(D)).toBe("2026-11");
  });
});

describe("objectives and key dates", () => {
  it("keeps up to 3 cleaned objectives and clears empty months", () => {
    let s = reducer(emptyState(), {
      type: "setObjectives",
      month: "2026-11",
      objectives: ["  Launch  v1 ", "", "Get 10 users", "Run 3x a week", "Fourth"],
    });
    expect(s.objectives["2026-11"]).toEqual(["Launch v1", "Get 10 users", "Run 3x a week"]);
    s = reducer(s, { type: "setObjectives", month: "2026-11", objectives: ["", "  "] });
    expect(s.objectives).toEqual({});
  });

  it("sets, trims and removes key dates", () => {
    let s = reducer(emptyState(), { type: "setKeyDate", date: "2026-11-16", label: " Launch " });
    expect(s.keyDates).toEqual({ "2026-11-16": "Launch" });
    s = reducer(s, { type: "setKeyDate", date: "2026-11-20", label: "x".repeat(200) });
    expect(s.keyDates["2026-11-20"]).toHaveLength(MAX_KEY_DATE_LENGTH);
    s = reducer(s, { type: "setKeyDate", date: "2026-11-16", label: "" });
    expect(Object.keys(s.keyDates)).toEqual(["2026-11-20"]);
  });

  it("lists upcoming key dates soonest first with countdowns", () => {
    const s = {
      ...stateOf(),
      keyDates: { "2026-11-01": "Past", "2026-12-25": "Holiday", "2026-11-04": "Today thing", "2026-11-16": "Launch" },
    };
    expect(upcomingKeyDates(s, D)).toEqual([
      { date: "2026-11-04", label: "Today thing", daysAway: 0 },
      { date: "2026-11-16", label: "Launch", daysAway: 12 },
      { date: "2026-12-25", label: "Holiday", daysAway: 51 },
    ]);
    expect(upcomingKeyDates(s, D, 1)).toHaveLength(1);
  });

  it("goal and timer actions keep objectives and key dates", () => {
    let s = reducer(emptyState(), { type: "setKeyDate", date: D, label: "Launch" });
    s = reducer(s, { type: "setObjectives", month: "2026-11", objectives: ["Ship"] });
    s = reducer(s, { type: "addGoal", date: D, id: "g", title: "Goal" });
    s = reducer(s, { type: "addSubtask", date: D, goalId: "g", id: "s", title: "Step", estimateMin: 5 });
    s = reducer(s, { type: "startTimer", date: D, goalId: "g", subtaskId: "s", now: 0 });
    s = reducer(s, { type: "pauseTimers", now: 1000 });
    expect(s.keyDates).toEqual({ [D]: "Launch" });
    expect(s.objectives).toEqual({ "2026-11": ["Ship"] });
  });
});

describe("saved data from before the War Map", () => {
  it("still loads and gains empty objectives and key dates", () => {
    const old = { version: 1, days: { [D]: { date: D, goals: [] } } };
    const store = { getItem: () => JSON.stringify(old), setItem: () => undefined };
    expect(loadState(store)).toEqual({
      state: { version: 1, days: old.days, objectives: {}, keyDates: {} },
      recovered: false,
    });
  });

  it("rejects malformed objectives or key dates", () => {
    expect(isAppState({ version: 1, days: {}, objectives: { "2026-11": "x" } })).toBe(false);
    expect(isAppState({ version: 1, days: {}, objectives: { nope: [] } })).toBe(false);
    expect(isAppState({ version: 1, days: {}, objectives: { "2026-11": ["a", "b", "c", "d"] } })).toBe(false);
    expect(isAppState({ version: 1, days: {}, keyDates: { "2026-11-04": 5 } })).toBe(false);
    expect(isAppState({ version: 1, days: {}, keyDates: { "../x": "a" } })).toBe(false);
    expect(isAppState({ version: 1, days: {}, objectives: {}, keyDates: { [D]: "ok" } })).toBe(true);
    expect(STORAGE_KEY).toBe("momentum:v1");
  });
});
