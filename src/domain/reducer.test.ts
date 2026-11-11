import { day, goal, stateOf, subtask } from "../test/factories";
import { trackedMs } from "./metrics";
import { carryOverCandidates, clampEstimate, cleanTitle, previousPlannedDay, reducer } from "./reducer";
import { emptyState, MAX_ESTIMATE, MAX_TITLE_LENGTH, type AppState } from "./types";

const D = "2026-11-04";
const MIN = 60_000;

function withGoal(): AppState {
  let s = reducer(emptyState(), { type: "addGoal", date: D, id: "g1", title: "Write report" });
  s = reducer(s, { type: "addSubtask", date: D, goalId: "g1", id: "s1", title: "Outline", estimateMin: 15 });
  s = reducer(s, { type: "addSubtask", date: D, goalId: "g1", id: "s2", title: "Draft", estimateMin: 45 });
  return s;
}

const sub = (s: AppState, id: string, date = D) =>
  s.days[date]!.goals.flatMap((g) => g.subtasks).find((x) => x.id === id)!;

describe("goals", () => {
  it("adds trimmed goals up to the max of 3", () => {
    let s = emptyState();
    for (const [i, t] of ["  A  ", "B", "C", "D"].entries()) {
      s = reducer(s, { type: "addGoal", date: D, id: `g${i}`, title: t });
    }
    expect(s.days[D]!.goals.map((g) => g.title)).toEqual(["A", "B", "C"]);
  });

  it("ignores empty titles and duplicate ids", () => {
    let s = reducer(emptyState(), { type: "addGoal", date: D, id: "g", title: "   " });
    expect(s).toEqual(emptyState());
    s = reducer(s, { type: "addGoal", date: D, id: "g", title: "One" });
    const again = reducer(s, { type: "addGoal", date: D, id: "g", title: "Two" });
    expect(again).toBe(s);
  });

  it("renames and deletes", () => {
    let s = withGoal();
    s = reducer(s, { type: "renameGoal", date: D, goalId: "g1", title: "Finish report" });
    expect(s.days[D]!.goals[0]!.title).toBe("Finish report");
    expect(reducer(s, { type: "renameGoal", date: D, goalId: "g1", title: " " })).toBe(s);
    s = reducer(s, { type: "deleteGoal", date: D, goalId: "g1", now: 0 });
    expect(s.days[D]!.goals).toEqual([]);
  });

  it("deleting a goal banks any running timer elsewhere first", () => {
    let s = withGoal();
    s = reducer(s, { type: "addGoal", date: D, id: "g2", title: "Other" });
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s1", now: 0 });
    s = reducer(s, { type: "deleteGoal", date: D, goalId: "g2", now: 10 * MIN });
    expect(sub(s, "s1")).toMatchObject({ trackedMs: 10 * MIN, timerStartedAt: null });
  });

  it("returns the same state for unknown targets", () => {
    const s = withGoal();
    expect(reducer(s, { type: "renameGoal", date: D, goalId: "nope", title: "x" })).toBe(s);
    expect(reducer(s, { type: "deleteSubtask", date: D, goalId: "g1", subtaskId: "nope" })).toBe(s);
    expect(reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "nope", now: 0 })).toBe(s);
  });
});

describe("subtasks", () => {
  it("adds with clamped estimates and edits", () => {
    let s = withGoal();
    s = reducer(s, { type: "addSubtask", date: D, goalId: "g1", id: "s3", title: "Huge", estimateMin: 9999 });
    expect(sub(s, "s3").estimateMin).toBe(MAX_ESTIMATE);
    s = reducer(s, { type: "setEstimate", date: D, goalId: "g1", subtaskId: "s3", estimateMin: 10 });
    s = reducer(s, { type: "renameSubtask", date: D, goalId: "g1", subtaskId: "s3", title: "Small" });
    expect(sub(s, "s3")).toMatchObject({ title: "Small", estimateMin: 10 });
    s = reducer(s, { type: "deleteSubtask", date: D, goalId: "g1", subtaskId: "s3" });
    expect(s.days[D]!.goals[0]!.subtasks).toHaveLength(2);
  });

  it("does not add subtasks to a missing goal", () => {
    const s = withGoal();
    expect(
      reducer(s, { type: "addSubtask", date: D, goalId: "zzz", id: "x", title: "x", estimateMin: 5 }),
    ).toBe(s);
  });

  it("toggling done stops and banks its timer; toggling back keeps time", () => {
    let s = withGoal();
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s1", now: 1000 });
    s = reducer(s, { type: "toggleSubtask", date: D, goalId: "g1", subtaskId: "s1", now: 1000 + 7 * MIN });
    expect(sub(s, "s1")).toMatchObject({ done: true, completedAt: 1000 + 7 * MIN, trackedMs: 7 * MIN, timerStartedAt: null });
    s = reducer(s, { type: "toggleSubtask", date: D, goalId: "g1", subtaskId: "s1", now: 0 });
    expect(sub(s, "s1")).toMatchObject({ done: false, completedAt: null, trackedMs: 7 * MIN });
  });
});

describe("timers", () => {
  it("only one timer runs at a time; starting another banks the first", () => {
    let s = withGoal();
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s1", now: 0 });
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s2", now: 5 * MIN });
    expect(sub(s, "s1")).toMatchObject({ trackedMs: 5 * MIN, timerStartedAt: null });
    expect(sub(s, "s2").timerStartedAt).toBe(5 * MIN);
  });

  it("pause, resume and accumulate", () => {
    let s = withGoal();
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s1", now: 0 });
    s = reducer(s, { type: "pauseTimers", now: 3 * MIN });
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s1", now: 10 * MIN });
    expect(trackedMs(sub(s, "s1"), 12 * MIN)).toBe(5 * MIN);
  });

  it("pauses timers running on another day", () => {
    let s = withGoal();
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s1", now: 0 });
    s = reducer(s, { type: "addGoal", date: "2026-11-05", id: "g9", title: "Tomorrow" });
    s = reducer(s, { type: "pauseTimers", now: 2 * MIN });
    expect(sub(s, "s1").timerStartedAt).toBeNull();
  });

  it("cannot start a done subtask or restart a running one", () => {
    let s = withGoal();
    s = reducer(s, { type: "toggleSubtask", date: D, goalId: "g1", subtaskId: "s1", now: 0 });
    expect(reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s1", now: 1 })).toBe(s);
    s = reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s2", now: 1 });
    expect(reducer(s, { type: "startTimer", date: D, goalId: "g1", subtaskId: "s2", now: 99 })).toBe(s);
  });

  it("pausing with nothing running is a no-op", () => {
    const s = withGoal();
    expect(reducer(s, { type: "pauseTimers", now: 1 })).toBe(s);
  });
});

describe("carry over", () => {
  const Y = "2026-11-03";
  function yesterday(): AppState {
    return stateOf(
      day(Y, [
        goal({ id: "a", title: "Done one", subtasks: [subtask({ done: true })] }),
        goal({
          id: "b",
          title: "Half",
          subtasks: [subtask({ id: "b1", done: true }), subtask({ id: "b2", trackedMs: 9 * MIN })],
        }),
        goal({ id: "c", title: "Empty" }),
      ]),
    );
  }

  it("brings unfinished goals forward with only their open steps and fresh time", () => {
    const s = reducer(yesterday(), { type: "carryOver", from: Y, to: D });
    const goals = s.days[D]!.goals;
    expect(goals.map((g) => g.id)).toEqual(["b", "c"]);
    expect(goals[0]!.subtasks.map((x) => x.id)).toEqual(["b2"]);
    expect(goals[0]!.subtasks[0]!.trackedMs).toBe(0);
    // history is untouched
    expect(s.days[Y]!.goals).toHaveLength(3);
  });

  it("respects the 3-goal max and never duplicates", () => {
    let s = yesterday();
    s = reducer(s, { type: "addGoal", date: D, id: "t1", title: "Today 1" });
    s = reducer(s, { type: "addGoal", date: D, id: "t2", title: "Today 2" });
    s = reducer(s, { type: "carryOver", from: Y, to: D });
    expect(s.days[D]!.goals.map((g) => g.id)).toEqual(["t1", "t2", "b"]);
    expect(reducer(s, { type: "carryOver", from: Y, to: D })).toBe(s);
  });

  it("lists candidates and finds the previous planned day", () => {
    const s = yesterday();
    expect(previousPlannedDay(s, D)).toBe(Y);
    expect(previousPlannedDay(s, Y)).toBeNull();
    expect(carryOverCandidates(s, Y, D).map((g) => g.id)).toEqual(["b", "c"]);
    expect(carryOverCandidates(s, null, D)).toEqual([]);
    expect(reducer(s, { type: "carryOver", from: D, to: D })).toBe(s);
    expect(reducer(s, { type: "carryOver", from: "2020-01-01", to: D })).toBe(s);
  });
});

describe("input cleaning", () => {
  it("collapses whitespace and caps length", () => {
    expect(cleanTitle("  a \n  b  ")).toBe("a b");
    expect(cleanTitle("x".repeat(500))).toHaveLength(MAX_TITLE_LENGTH);
  });

  it("clamps estimates", () => {
    expect(clampEstimate(Number.NaN)).toBe(1);
    expect(clampEstimate(0)).toBe(1);
    expect(clampEstimate(12.6)).toBe(13);
    expect(clampEstimate(10_000)).toBe(MAX_ESTIMATE);
  });
});
