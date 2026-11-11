import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App, momentumMessage, runningStep } from "./App";
import { addDays, toDateKey } from "./domain/dates";
import { STORAGE_KEY } from "./domain/storage";
import type { AppState } from "./domain/types";
import { browserApi, type DaySummary, type NativeApi, type TrackerConfig, type TrackerStatus } from "./platform/native";
import { day, goal, stateOf, subtask, workedDay } from "./test/factories";

const START = new Date(2026, 10, 4, 10, 0, 0).getTime();
const TODAY = toDateKey(new Date(START));

function setup(props: { initialState?: AppState; api?: NativeApi } = {}) {
  let t = START;
  let n = 0;
  const clock = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const user = userEvent.setup();
  const utils = render(
    <App clock={clock} makeId={() => `id-${++n}`} api={props.api ?? browserApi} initialState={props.initialState} />,
  );
  return { user, advance, ...utils };
}

async function addGoal(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.type(screen.getByLabelText(/has to get done today|Add another non-negotiable/), `${title}{Enter}`);
}

async function addStep(user: ReturnType<typeof userEvent.setup>, goalTitle: string, step: string) {
  await user.type(screen.getByLabelText(`New step for ${goalTitle}`), `${step}{Enter}`);
}

describe("daily non-negotiables", () => {
  it("plans goals and steps, completes them, and saves locally", async () => {
    const { user } = setup();
    expect(screen.getByTestId("momentum-msg")).toHaveTextContent("Pick 2–3 non-negotiables");

    await addGoal(user, "Ship onboarding email");
    await addStep(user, "Ship onboarding email", "Write subject line");
    expect(screen.getByText("0 of 1 step · ~25m")).toBeInTheDocument();
    await addStep(user, "Ship onboarding email", "Draft body");
    expect(screen.getByText("0 of 2 steps · ~50m")).toBeInTheDocument();
    expect(screen.getByTestId("up-next")).toHaveTextContent("Write subject line");
    expect(screen.getByTestId("goals-count")).toHaveTextContent("0/1 goals");

    await user.click(screen.getByLabelText("Mark done: Write subject line"));
    expect(screen.getByTestId("momentum-msg")).toHaveTextContent("1 step done");
    expect(screen.getByTestId("up-next")).toHaveTextContent("Draft body");

    await user.click(screen.getByLabelText("Mark done: Draft body"));
    expect(screen.getByTestId("goals-count")).toHaveTextContent("1/1 goals");
    expect(screen.getByTestId("momentum-msg")).toHaveTextContent("Every non-negotiable is done");
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByTestId("up-next")).not.toBeInTheDocument();
    // Untimed finished steps count their 25-minute default estimate.
    expect(screen.getByTestId("today-work")).toHaveTextContent("50m");

    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as AppState;
    expect(saved.days[TODAY]!.goals[0]!.subtasks.every((s) => s.done)).toBe(true);
  });

  it("caps the day at three goals", async () => {
    const { user } = setup();
    for (const g of ["One", "Two", "Three"]) await addGoal(user, g);
    expect(screen.getByTestId("max-goals-note")).toHaveTextContent("That's 3");
    expect(screen.queryByLabelText(/Add another non-negotiable/)).not.toBeInTheDocument();
  });

  it("renames, re-estimates and deletes with confirmation", async () => {
    const { user } = setup();
    await addGoal(user, "Old name");
    await addStep(user, "Old name", "Step A");
    await user.click(screen.getByLabelText("Rename goal: Old name"));
    const input = screen.getByLabelText("New name for goal");
    await user.clear(input);
    await user.type(input, "New name{Enter}");
    expect(screen.getByLabelText("Rename goal: New name")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Estimate for Step A"), "60");
    expect(screen.getByTestId("today-planned")).toHaveTextContent("1h");

    await user.click(screen.getByLabelText("Delete subtask Step A"));
    expect(screen.queryByText("Step A")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Delete goal New name"));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByLabelText("Rename goal: New name")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Delete goal New name"));
    await user.click(screen.getByRole("button", { name: "Delete goal" }));
    expect(screen.queryByLabelText("Rename goal: New name")).not.toBeInTheDocument();
  });

  it("times real work and counts it when the step is done", async () => {
    const { user, advance } = setup();
    await addGoal(user, "Report");
    await addStep(user, "Report", "Outline");
    await user.click(screen.getByLabelText("Start focus timer for Outline"));
    expect(screen.getByLabelText("Pause timer for Outline")).toBeInTheDocument();
    advance(40 * 60_000);
    await user.click(screen.getByLabelText("Pause timer for Outline"));
    expect(screen.getByText("40:00")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Mark done: Outline"));
    expect(screen.getByText("40m real work")).toBeInTheDocument();
    expect(screen.getByTestId("today-work")).toHaveTextContent("40m");
  });

  it("offers to bring yesterday's unfinished goals forward", async () => {
    const yesterday = addDays(TODAY, -1);
    const initialState = stateOf(
      day(yesterday, [
        goal({ id: "a", title: "Finished", subtasks: [subtask({ done: true })] }),
        goal({ id: "b", title: "Half done", subtasks: [subtask({ done: true }), subtask({ title: "Left over" })] }),
      ]),
    );
    const { user } = setup({ initialState });
    const region = screen.getByRole("region", { name: "Unfinished goals" });
    expect(region).toHaveTextContent("1 unfinished goal");
    await user.click(within(region).getByRole("button", { name: "Bring it forward" }));
    expect(screen.getByLabelText("Rename goal: Half done")).toBeInTheDocument();
    expect(screen.getByLabelText("Mark done: Left over")).toBeInTheDocument();
    expect(screen.getByTestId("up-next")).toHaveTextContent("Left over");
    expect(screen.queryByRole("region", { name: "Unfinished goals" })).not.toBeInTheDocument();
  });

  it("can dismiss the carry-over offer", async () => {
    const initialState = stateOf(day(addDays(TODAY, -1), [goal({ title: "Open", subtasks: [subtask()] })]));
    const { user } = setup({ initialState });
    await user.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(screen.queryByRole("region", { name: "Unfinished goals" })).not.toBeInTheDocument();
  });
});

describe("capacity", () => {
  it("calibrates first", () => {
    setup();
    expect(screen.getByText(/5 more days of plans/)).toBeInTheDocument();
  });

  it("shows your consistent capacity and warns when today is over-planned", () => {
    const history = Array.from({ length: 6 }, (_, i) => workedDay(addDays(TODAY, -(i + 1)), 120, false));
    const today = day(TODAY, [goal({ title: "Big day", subtasks: [subtask({ estimateMin: 240 })] })]);
    setup({ initialState: stateOf(...history, today) });
    expect(screen.getByTestId("capacity-number")).toHaveTextContent("2h");
    expect(screen.getByText(/2h more than you reliably do/)).toBeInTheDocument();
  });
});

// ---------- Mac app integration ----------

const CONFIG: TrackerConfig = {
  trackingEnabled: true,
  recordTitles: false,
  guardMode: "nudge",
  distractingApps: ["com.hnc.Discord"],
  distractingKeywords: ["YouTube"],
  idleThresholdSecs: 180,
  breakAfterMin: 90,
};

const zero = { focusMs: 0, communicationMs: 0, distractionMs: 0, otherMs: 0 };

function fakeApi(overrides: Partial<TrackerStatus> = {}) {
  const listeners: Record<string, (payload: never) => void> = {};
  const status: TrackerStatus = {
    supported: true,
    accessibilityTrusted: true,
    trackingEnabled: true,
    idle: false,
    focusActive: false,
    snoozedUntilMs: null,
    current: { appName: "Code", bundleId: "com.microsoft.VSCode", windowTitle: null, category: "focus" },
    ...overrides,
  };
  const hours = Array.from({ length: 24 }, () => ({ ...zero }));
  hours[9] = { ...zero, focusMs: 30 * 60_000 };
  const summary: DaySummary = {
    date: TODAY,
    activeMs: 50 * 60_000,
    totals: { focusMs: 30 * 60_000, communicationMs: 15 * 60_000, distractionMs: 5 * 60_000, otherMs: 0 },
    topApps: [{ appName: "Code", bundleId: "com.microsoft.VSCode", category: "focus", ms: 30 * 60_000 }],
    hours,
    firstMs: START - 3_600_000,
    lastMs: START,
  };
  const on = (name: string) => (cb: (p: never) => void) => {
    listeners[name] = cb;
    return Promise.resolve(() => delete listeners[name]);
  };
  const api = {
    available: true,
    getStatus: vi.fn(() => Promise.resolve(status)),
    getConfig: vi.fn(() => Promise.resolve(CONFIG)),
    setConfig: vi.fn((c: TrackerConfig) => Promise.resolve(c)),
    getDaySummary: vi.fn(() => Promise.resolve(summary)),
    setFocus: vi.fn(() => Promise.resolve()),
    snoozeGuard: vi.fn(() => Promise.resolve()),
    takeBreak: vi.fn(() => Promise.resolve()),
    requestAccessibility: vi.fn(() => Promise.resolve(false)),
    deleteActivity: vi.fn(() => Promise.resolve()),
    onDistraction: on("distraction"),
    onBreak: on("break"),
    onIdle: on("idle"),
    onStorageError: on("storage"),
  } satisfies NativeApi;
  const emit = (name: string, payload: unknown) =>
    act(() => {
      listeners[name]?.(payload as never);
    });
  return { api, emit, listeners };
}

describe("Mac tracking", () => {
  it("explains that tracking needs the Mac app when running in a browser", () => {
    setup();
    expect(screen.getByText(/run in the Momentum Mac app/)).toBeInTheDocument();
  });

  it("shows today's activity and the current app", async () => {
    const { api } = fakeApi();
    setup({ api });
    expect(await screen.findByTestId("active-total")).toHaveTextContent("50m");
    expect(screen.getByTestId("now-activity")).toHaveTextContent("Now: Code");
    expect(api.getDaySummary).toHaveBeenCalledWith(TODAY);
  });

  it("asks for Accessibility when it isn't granted", async () => {
    const { api } = fakeApi({ accessibilityTrusted: false });
    const { user } = setup({ api });
    await user.click(await screen.findByRole("button", { name: "Allow…" }));
    expect(api.requestAccessibility).toHaveBeenCalled();
    expect(screen.getByText(/Privacy & Security → Accessibility/)).toBeInTheDocument();
  });

  it("pauses and resumes tracking", async () => {
    const { api } = fakeApi();
    const { user } = setup({ api });
    await user.click(await screen.findByRole("checkbox", { name: "Tracking" }));
    expect(api.setConfig).toHaveBeenCalledWith({ ...CONFIG, trackingEnabled: false });
  });

  it("tells the guard which step is in focus", async () => {
    const { api } = fakeApi();
    const { user } = setup({ api });
    await addGoal(user, "Write");
    await addStep(user, "Write", "Intro");
    await user.click(screen.getByLabelText("Start focus timer for Intro"));
    expect(api.setFocus).toHaveBeenLastCalledWith(true, "Intro");
    await user.click(screen.getByLabelText("Pause timer for Intro"));
    expect(api.setFocus).toHaveBeenLastCalledWith(false, null);
  });

  it("shows a distraction prompt and can snooze the guard", async () => {
    const { api, emit, listeners } = fakeApi();
    const { user } = setup({ api });
    await screen.findByTestId("active-total");
    expect(listeners.distraction).toBeDefined();
    emit("distraction", { appName: "Safari", windowTitle: "YouTube", blocked: true, focusLabel: "Intro" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Drifted to Safari");
    expect(dialog).toHaveTextContent("“Intro”");
    expect(dialog).toHaveTextContent("Momentum hid it for you");
    await user.click(within(dialog).getByRole("button", { name: "Give me 5 minutes" }));
    expect(api.snoozeGuard).toHaveBeenCalledWith(5);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("break reminder pauses the running timer when you take the break", async () => {
    const { api, emit } = fakeApi();
    const { user, advance } = setup({ api });
    await addGoal(user, "Deep work");
    await addStep(user, "Deep work", "Chapter 1");
    await user.click(screen.getByLabelText("Start focus timer for Chapter 1"));
    advance(90 * 60_000);
    emit("break", { activeMinutes: 90 });
    expect(screen.getByRole("dialog")).toHaveTextContent("going for 90 minutes");
    await user.click(screen.getByRole("button", { name: "Take a break" }));
    expect(api.takeBreak).toHaveBeenCalled();
    expect(screen.getByLabelText("Start focus timer for Chapter 1")).toBeInTheDocument();
    expect(screen.getByText("1:30:00")).toBeInTheDocument();
  });

  it("pauses the timer back to when you stepped away", async () => {
    const { api, emit } = fakeApi();
    const { user, advance } = setup({ api });
    await addGoal(user, "Deep work");
    await addStep(user, "Deep work", "Chapter 1");
    await user.click(screen.getByLabelText("Start focus timer for Chapter 1"));
    advance(30 * 60_000);
    emit("idle", { sinceMs: START + 10 * 60_000 });
    expect(screen.getByText(/You stepped away at/)).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText(/You stepped away at/)).not.toBeInTheDocument();
  });

  it("ignores idle when no timer is running", async () => {
    const { api, emit } = fakeApi();
    setup({ api });
    await screen.findByTestId("active-total");
    emit("idle", { sinceMs: START });
    expect(screen.queryByText(/You stepped away at/)).not.toBeInTheDocument();
  });

  it("saves guard settings from the form", async () => {
    const { api } = fakeApi();
    const { user } = setup({ api });
    await user.click(await screen.findByText("Focus guard & privacy"));
    await user.click(screen.getByRole("radio", { name: /Block/ }));
    const keywords = screen.getByLabelText(/Distracting sites/);
    await user.clear(keywords);
    await user.type(keywords, "Reddit{Enter}  {Enter}Hacker News");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(api.setConfig).toHaveBeenCalledWith({
      ...CONFIG,
      guardMode: "block",
      distractingKeywords: ["Reddit", "Hacker News"],
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("deletes activity history after confirming", async () => {
    const { api } = fakeApi();
    const { user } = setup({ api });
    await user.click(await screen.findByText("Focus guard & privacy"));
    await user.click(screen.getByRole("button", { name: "Delete my activity history…" }));
    await user.click(screen.getByRole("button", { name: "Delete activity" }));
    expect(api.deleteActivity).toHaveBeenCalled();
    expect(await screen.findByText("Activity deleted")).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("momentum messages never shame", () => {
    expect(momentumMessage(0, 0, 0, false)).toMatch(/Pick 2–3/);
    expect(momentumMessage(0, 0, 2, false)).toMatch(/small steps/);
    expect(momentumMessage(0, 3, 2, false)).toMatch(/smallest step/);
    expect(momentumMessage(1, 3, 2, false)).toBe("1 step done — keep the chain going.");
    expect(momentumMessage(3, 3, 2, true)).toMatch(/win/);
  });

  it("finds the running step", () => {
    const s = subtask({ timerStartedAt: 5 });
    expect(runningStep(stateOf(day(TODAY, [goal({ subtasks: [subtask(), s] })])))?.subtask).toBe(s);
    expect(runningStep(stateOf())).toBeNull();
  });
});

describe("unsupported OS", () => {
  it("says tracking needs macOS when the shell reports no support", async () => {
    const { api } = fakeApi({ supported: false });
    setup({ api });
    expect(await screen.findByText(/available on macOS/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow…" })).not.toBeInTheDocument();
  });
});

describe("War Map", () => {
  it("prompts for monthly objectives on Today and opens the War Map", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Give November up to 3 main objectives/ }));
    expect(screen.getByRole("heading", { name: "War Map 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "War Map" })).toHaveAttribute("aria-pressed", "true");
  });

  it("colours days from real results and shows the selected day", async () => {
    const initialState = stateOf(
      day(addDays(TODAY, -2), [goal({ title: "Shipped it", subtasks: [subtask({ done: true })] })]),
      day(addDays(TODAY, -1), [goal({ title: "Half", subtasks: [subtask({ done: true }), subtask()] })]),
      day(TODAY, [goal({ title: "Today goal", subtasks: [subtask()] })]),
    );
    const { user } = setup({ initialState });
    await user.click(screen.getByRole("button", { name: "War Map" }));
    expect(screen.getByRole("button", { name: /Monday, Nov 2: every non-negotiable done/ })).toHaveClass("s-win");
    expect(screen.getByRole("button", { name: /Tuesday, Nov 3: in progress/ })).toHaveClass("s-partial");
    const todayCell = screen.getByRole("button", { name: /Wednesday, Nov 4: planned/ });
    expect(todayCell).toHaveClass("s-planned", "is-today");
    expect(screen.getByRole("button", { name: /Thursday, Nov 5: no plan/ })).toHaveClass("s-none");
    expect(screen.getByTestId("wm-stats")).toHaveTextContent("1 winning day");

    await user.click(screen.getByRole("button", { name: /Monday, Nov 2:/ }));
    expect(screen.getByRole("heading", { name: "Monday, Nov 2" })).toBeInTheDocument();
    expect(screen.getByTestId("wm-day-summary")).toHaveTextContent("1 of 1 goals done");
    expect(screen.getByText("Shipped it")).toBeInTheDocument();
  });

  it("sets monthly objectives and a key date, then shows them on Today", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "War Map" }));
    await user.type(screen.getByLabelText("November objective 1"), "Launch Momentum v1");
    await user.type(screen.getByLabelText("November objective 2"), "Run 3x a week");
    await user.click(screen.getByRole("button", { name: "Save objectives" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByText("Launch Momentum v1", { selector: ".wm-obj li" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Monday, Nov 16/ }));
    await user.type(screen.getByLabelText("Key date"), "Launch day");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: /Monday, Nov 16: no plan · Launch day/ })).toHaveClass("has-key");
    expect(screen.getByTestId("wm-stats")).toHaveTextContent("1 key date");

    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId("month-objectives")).toHaveTextContent("Launch Momentum v1");
    expect(screen.getByTestId("month-objectives")).toHaveTextContent("Run 3x a week");
    expect(screen.getByTestId("key-date")).toHaveTextContent("Launch day in 12 days (Nov 16)");

    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as AppState;
    expect(saved.objectives["2026-11"]).toEqual(["Launch Momentum v1", "Run 3x a week"]);
    expect(saved.keyDates).toEqual({ "2026-11-16": "Launch day" });
  });

  it("removes a key date and switches years", async () => {
    const initialState = { ...stateOf(), keyDates: { "2026-11-05": "Dentist" } };
    const { user } = setup({ initialState });
    await user.click(screen.getByRole("button", { name: "War Map" }));
    await user.click(screen.getByRole("button", { name: /Thursday, Nov 5/ }));
    expect(screen.getByLabelText("Key date")).toHaveValue("Dentist");
    await user.click(screen.getByRole("button", { name: "Remove key date" }));
    expect(screen.getByRole("button", { name: /Thursday, Nov 5: no plan$/ })).not.toHaveClass("has-key");

    await user.click(screen.getByRole("button", { name: "Next year" }));
    expect(screen.getByRole("heading", { name: "War Map 2027" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Friday, Jan 1" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous year" }));
    expect(screen.getByRole("heading", { name: "Wednesday, Nov 4" })).toBeInTheDocument();
  });

  it("shows tomorrow and today countdowns", () => {
    const initialState = { ...stateOf(), keyDates: { [TODAY]: "Demo", [addDays(TODAY, 1)]: "Review" } };
    setup({ initialState });
    const dates = screen.getAllByTestId("key-date");
    expect(dates[0]).toHaveTextContent("Demo today");
    expect(dates[1]).toHaveTextContent("Review tomorrow");
  });
});
