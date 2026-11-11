import { expect, test, type Page } from "@playwright/test";

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test.afterEach(() => {
  expect(errors, "no console or page errors").toEqual([]);
});

async function addGoal(page: Page, title: string) {
  await page.getByLabel(/has to get done today|Add another non-negotiable/).fill(title);
  await page.getByRole("button", { name: "Add goal" }).click();
}

async function addStep(page: Page, goal: string, step: string, estimate?: string) {
  if (estimate) await page.getByLabel(`Estimate for new step in ${goal}`).selectOption(estimate);
  await page.getByLabel(`New step for ${goal}`).fill(step);
  await page.getByLabel(`New step for ${goal}`).press("Enter");
}

test("plan a day, focus, finish, and keep it after reload", async ({ page }) => {
  await expect(page.getByTestId("momentum-msg")).toContainText("Pick 2–3 non-negotiables");

  await addGoal(page, "Ship onboarding email");
  await addStep(page, "Ship onboarding email", "Write subject line", "10");
  await addStep(page, "Ship onboarding email", "Draft the body", "45");
  await addGoal(page, "Workout");
  await addStep(page, "Workout", "20 min walk", "25");

  await expect(page.getByTestId("up-next")).toHaveText("Write subject line");
  await expect(page.getByTestId("today-planned")).toHaveText("1h 20m");

  // Focus timer runs and ticks.
  await page.getByRole("button", { name: "Start it" }).click();
  await expect(page.getByLabel("Pause timer for Write subject line")).toBeVisible();
  await expect(page.locator(".timer-chip")).toHaveText(/0:0[1-9]/, { timeout: 5000 });
  await page.getByLabel("Mark done: Write subject line").check();

  await page.getByLabel("Mark done: Draft the body").check();
  await expect(page.getByLabel("Goal 1: Ship onboarding email")).toContainText("Done");
  await expect(page.getByTestId("goals-count")).toHaveText("1/2 goals");

  await page.reload();
  await expect(page.getByTestId("goals-count")).toHaveText("1/2 goals");
  await expect(page.getByTestId("up-next")).toHaveText("20 min walk");

  await page.getByLabel("Mark done: 20 min walk").check();
  await expect(page.getByTestId("momentum-msg")).toContainText("Every non-negotiable is done");
  await page.screenshot({ path: "test-results/momentum-day-done.png", fullPage: true });
});

test("never more than three goals", async ({ page }) => {
  for (const g of ["One", "Two", "Three"]) await addGoal(page, g);
  await expect(page.getByTestId("max-goals-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add goal" })).toHaveCount(0);
});

test("fits a narrow window without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await addGoal(page, "A goal with a fairly long title that should wrap nicely on small windows");
  await addStep(page, "A goal with a fairly long title that should wrap nicely on small windows", "A step");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("shows that tracking needs the Mac app in a plain browser", async ({ page }) => {
  await expect(page.getByText(/run in the Momentum Mac app/)).toBeVisible();
});

test("War Map: objectives and key dates persist and show on Today", async ({ page }) => {
  await addGoal(page, "Ship onboarding email");
  await addStep(page, "Ship onboarding email", "Write subject line");
  await page.getByLabel("Mark done: Write subject line").check();

  await page.getByRole("button", { name: "War Map", exact: true }).click();
  const year = new Date().getFullYear();
  await expect(page.getByRole("heading", { name: `War Map ${year}` })).toBeVisible();
  await expect(page.locator(".wm-day.is-today")).toHaveClass(/s-win/);

  const month = new Date().toLocaleDateString("en-US", { month: "long" });
  await page.getByLabel(`${month} objective 1`).fill("Launch Momentum v1");
  await page.getByLabel(`${month} objective 2`).fill("Run 3x a week");
  await page.getByRole("button", { name: "Save objectives" }).click();

  // Mark a key date 10 days out (may fall in next month: still within this year view unless December).
  const target = new Date();
  target.setDate(target.getDate() + 10);
  if (target.getFullYear() === year) {
    const label = target.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
    await page.getByLabel("Key date").fill("Launch day");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${label}:.*Launch day`) })).toHaveClass(/has-key/);
  }
  await page.screenshot({ path: "test-results/momentum-war-map.png", fullPage: true });

  await page.reload();
  await expect(page.getByTestId("month-objectives")).toContainText("Launch Momentum v1");
  if (target.getFullYear() === year) await expect(page.getByTestId("key-date")).toContainText("Launch day in 10 days");
});

test("War Map fits a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.getByRole("button", { name: "War Map", exact: true }).click();
  await expect(page.locator(".wm-month")).toHaveCount(12);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
