import { day, goal, stateOf, subtask, workedDay } from "../test/factories";
import { addDays } from "./dates";
import {
  checkPlan,
  computeCapacity,
  currentRun,
  dayPlannedMinutes,
  dayProgress,
  dayWorkMinutes,
  isGoalDone,
  lowerPercentile,
  nextStep,
  recentHistory,
  subtaskWorkMinutes,
  totalAllInDays,
  trackedMs,
} from "./metrics";
import { MAX_TIMER_RUN_MS } from "./types";

const MIN = 60_000;
const TODAY = "2026-11-04";

describe("real work minutes", () => {
  it("counts tracked time on a running timer, capped for forgotten timers", () => {
    expect(trackedMs(subtask({ trackedMs: 5 * MIN, timerStartedAt: 1000 }), 1000 + 3 * MIN)).toBe(8 * MIN);
    expect(trackedMs(subtask({ timerStartedAt: 0 }), 10 * MAX_TIMER_RUN_MS)).toBe(MAX_TIMER_RUN_MS);
    expect(trackedMs(subtask({ timerStartedAt: 5000 }), 1000)).toBe(0);
  });

  it("uses real tracked time for finished timed steps and the estimate otherwise", () => {
    expect(subtaskWorkMinutes(subtask({ done: true, estimateMin: 25, trackedMs: 40 * MIN }), 0)).toBe(40);
    expect(subtaskWorkMinutes(subtask({ done: true, estimateMin: 25, trackedMs: 20_000 }), 0)).toBe(25);
    expect(subtaskWorkMinutes(subtask({ done: false, estimateMin: 25, trackedMs: 12.9 * MIN }), 0)).toBe(12);
    expect(subtaskWorkMinutes(subtask({ done: false, estimateMin: 25 }), 0)).toBe(0);
  });

  it("sums work and plan for a day", () => {
    const plan = day(TODAY, [
      goal({
        subtasks: [
          subtask({ done: true, estimateMin: 30 }),
          subtask({ estimateMin: 15, trackedMs: 20 * MIN }),
          subtask({ estimateMin: 45 }),
        ],
      }),
    ]);
    expect(dayWorkMinutes(plan, 0)).toBe(30 + 20);
    expect(dayPlannedMinutes(plan, 0)).toBe(30 + 20 + 45);
    expect(dayWorkMinutes(undefined, 0)).toBe(0);
    expect(dayPlannedMinutes(undefined, 0)).toBe(0);
  });
});

describe("progress", () => {
  it("a goal is done only when it has steps and all are done", () => {
    expect(isGoalDone(goal())).toBe(false);
    expect(isGoalDone(goal({ subtasks: [subtask({ done: true }), subtask()] }))).toBe(false);
    expect(isGoalDone(goal({ subtasks: [subtask({ done: true })] }))).toBe(true);
  });

  it("summarises the day", () => {
    const plan = day(TODAY, [
      goal({ subtasks: [subtask({ done: true }), subtask({ done: true })] }),
      goal({ subtasks: [subtask({ done: true }), subtask()] }),
    ]);
    expect(dayProgress(plan)).toEqual({
      subtasksDone: 3,
      subtasksTotal: 4,
      goalsDone: 1,
      goalsTotal: 2,
      allGoalsDone: false,
    });
    expect(dayProgress(undefined).allGoalsDone).toBe(false);
  });

  it("finds the next tiny step in goal order", () => {
    const first = subtask({ done: true });
    const second = subtask({ title: "second" });
    const g2 = goal({ subtasks: [subtask({ title: "later" })] });
    const plan = day(TODAY, [goal({ subtasks: [first, second] }), g2]);
    expect(nextStep(plan)?.subtask.title).toBe("second");
    expect(nextStep(day(TODAY, [goal({ subtasks: [subtask({ done: true })] })]))).toBeNull();
    expect(nextStep(undefined)).toBeNull();
  });

  it("counts a run of winning days without punishing an unfinished today", () => {
    const state = stateOf(
      workedDay(addDays(TODAY, -3), 30),
      workedDay(addDays(TODAY, -2), 30),
      workedDay(addDays(TODAY, -1), 30),
      workedDay(TODAY, 30, false),
    );
    expect(currentRun(state, TODAY)).toBe(3);
    state.days[TODAY] = workedDay(TODAY, 30, true);
    expect(currentRun(state, TODAY)).toBe(4);
    expect(totalAllInDays(state)).toBe(4);
  });

  it("a day without a plan ends the run", () => {
    const state = stateOf(workedDay(addDays(TODAY, -3), 30), workedDay(addDays(TODAY, -1), 30));
    expect(currentRun(state, TODAY)).toBe(1);
  });
});

describe("consistent capacity", () => {
  it("lowerPercentile returns the value met on at least the given share of days", () => {
    expect(lowerPercentile([], 0.8)).toBe(0);
    expect(lowerPercentile([100, 50, 200, 150, 120], 0.8)).toBe(50);
    const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(lowerPercentile(ten, 0.8)).toBe(20);
    expect(ten.filter((v) => v >= 20).length / ten.length).toBeGreaterThanOrEqual(0.8);
  });

  it("calibrates until 5 planned days exist, ignoring today and empty days", () => {
    const state = stateOf(
      workedDay(addDays(TODAY, -1), 60),
      workedDay(addDays(TODAY, -2), 60),
      day(addDays(TODAY, -3), [goal()]),
      workedDay(TODAY, 600),
    );
    const cap = computeCapacity(state, TODAY, 0);
    expect(cap).toMatchObject({ status: "calibrating", daysLogged: 2, daysNeeded: 5 });
  });

  it("reports the amount reached on 80%+ of recent days, rounded down to 5 minutes", () => {
    const minutes = [182, 150, 95, 240, 160, 175, 30, 168, 171, 190];
    const state = stateOf(...minutes.map((m, i) => workedDay(addDays(TODAY, -(i + 1)), m, false)));
    const cap = computeCapacity(state, TODAY, 0);
    expect(cap.status).toBe("ready");
    if (cap.status !== "ready") return;
    // sorted: 30, 95, 150, ... -> 80% of 10 days reach >= 95 -> 95
    expect(cap.consistentMinutes).toBe(95);
    expect(cap.averageMinutes).toBe(156);
    expect(cap.bestMinutes).toBe(240);
    expect(cap.daysUsed).toBe(10);
    expect(cap.stretchMinutes).toBeNull();
  });

  it("only uses the most recent 14 planned days", () => {
    const state = stateOf(
      ...Array.from({ length: 20 }, (_, i) => workedDay(addDays(TODAY, -(i + 1)), i < 14 ? 120 : 5)),
    );
    expect(recentHistory(state, TODAY, 0)).toHaveLength(14);
    const cap = computeCapacity(state, TODAY, 0);
    expect(cap.status === "ready" && cap.consistentMinutes).toBe(120);
  });

  it("suggests a ~10% stretch after 5 days of finishing everything", () => {
    const state = stateOf(...Array.from({ length: 6 }, (_, i) => workedDay(addDays(TODAY, -(i + 1)), 120)));
    const cap = computeCapacity(state, TODAY, 0);
    expect(cap.status === "ready" && cap.stretchMinutes).toBe(130);
  });

  it("does not suggest a stretch when a recent day was unfinished", () => {
    const plans = Array.from({ length: 6 }, (_, i) => workedDay(addDays(TODAY, -(i + 1)), 120, i !== 2));
    const cap = computeCapacity(stateOf(...plans), TODAY, 0);
    expect(cap.status === "ready" && cap.stretchMinutes).toBeNull();
  });

  it("warns when today's plan is well over capacity", () => {
    const state = stateOf(...Array.from({ length: 5 }, (_, i) => workedDay(addDays(TODAY, -(i + 1)), 100, false)));
    const cap = computeCapacity(state, TODAY, 0);
    expect(checkPlan(cap, 110)).toMatchObject({ kind: "ok", capacityMinutes: 100 });
    expect(checkPlan(cap, 115)).toMatchObject({ kind: "ok" });
    expect(checkPlan(cap, 116)).toMatchObject({ kind: "over", overByMinutes: 16 });
  });

  it("can't judge a plan while calibrating or with zero capacity", () => {
    expect(checkPlan(computeCapacity(stateOf(), TODAY, 0), 500)).toEqual({ kind: "unknown" });
    const zeros = stateOf(...Array.from({ length: 5 }, (_, i) => workedDay(addDays(TODAY, -(i + 1)), 0)));
    expect(checkPlan(computeCapacity(zeros, TODAY, 0), 500)).toEqual({ kind: "unknown" });
  });
});
