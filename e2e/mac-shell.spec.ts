import { expect, test } from "@playwright/test";

/**
 * Runs the real frontend bridge (@tauri-apps/api) against a simulated Tauri shell,
 * checking command names and arguments match the Rust side.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type Cb = (msg: unknown) => void;
    const callbacks = new Map<number, Cb>();
    const listeners = new Map<string, number[]>();
    let nextId = 1;
    const calls: { cmd: string; args: unknown }[] = [];
    let config = {
      trackingEnabled: true,
      recordTitles: false,
      trackUrls: true,
      guardMode: "nudge",
      distractionGraceSecs: 10,
      distractingApps: ["com.hnc.Discord"],
      distractingSites: ["youtube.com", "reddit.com"],
      distractingKeywords: ["YouTube", "Reddit"],
      privateApps: ["com.1password.1password"],
      idleThresholdSecs: 180,
      breakAfterMin: 90,
    };
    const zero = { focusMs: 0, meetingMs: 0, communicationMs: 0, distractionMs: 0, otherMs: 0 };
    const hours = Array.from({ length: 24 }, (_, h) =>
      h >= 9 && h <= 13
        ? {
            focusMs: (25 + h) * 60_000,
            meetingMs: h === 10 ? 30 * 60_000 : 0,
            communicationMs: 12 * 60_000,
            distractionMs: (h === 11 ? 14 : 3) * 60_000,
            otherMs: 4 * 60_000,
          }
        : { ...zero },
    );
    const sum = (k: keyof typeof zero) => hours.reduce((a, h) => a + h[k], 0);
    const totals = {
      focusMs: sum("focusMs"),
      meetingMs: sum("meetingMs"),
      communicationMs: sum("communicationMs"),
      distractionMs: sum("distractionMs"),
      otherMs: sum("otherMs"),
    };
    const w = window as unknown as Record<string, unknown>;
    w.__calls = calls;
    w.__emit = (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: Cb) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "plugin:event|listen": {
            const list = listeners.get(args.event as string) ?? [];
            list.push(args.handler as number);
            listeners.set(args.event as string, list);
            return args.handler;
          }
          case "plugin:event|unlisten":
            return null;
          case "get_status":
            return {
              supported: true,
              accessibilityTrusted: false,
              trackingEnabled: config.trackingEnabled,
              idle: false,
              focusActive: false,
              snoozedUntilMs: null,
              activeSinceMs: Date.now() - 52 * 60_000,
              current: { appName: "Visual Studio Code", bundleId: "com.microsoft.VSCode", windowTitle: null, site: null, category: "focus" },
            };
          case "get_config":
            return config;
          case "set_config":
            config = args.config as typeof config;
            return config;
          case "get_day_summary":
            return {
              date: args.date,
              activeMs: totals.focusMs + totals.meetingMs + totals.communicationMs + totals.distractionMs + totals.otherMs,
              totals,
              topApps: [
                { appName: "Visual Studio Code", bundleId: "com.microsoft.VSCode", category: "focus", ms: totals.focusMs - 20 * 60_000 },
                { appName: "Figma", bundleId: "com.figma.Desktop", category: "focus", ms: 20 * 60_000 },
                { appName: "Slack", bundleId: "com.tinyspeck.slackmacgap", category: "communication", ms: totals.communicationMs },
                { appName: "zoom.us", bundleId: "us.zoom.xos", category: "meeting", ms: totals.meetingMs },
                { appName: "Safari", bundleId: "com.apple.Safari", category: "distraction", ms: totals.distractionMs },
              ],
              topSites: [
                { host: "youtube.com", category: "distraction", ms: totals.distractionMs - 9 * 60_000 },
                { host: "github.com", category: "focus", ms: 20 * 60_000 },
                { host: "reddit.com", category: "distraction", ms: 9 * 60_000 },
              ],
              hours,
              firstMs: null,
              lastMs: null,
            };
          case "set_focus":
          case "snooze_guard":
          case "take_break":
          case "delete_activity":
          case "allow_for_session":
          case "release_window":
            return null;
          case "request_accessibility":
            return false;
          default:
            throw new Error(`unknown command ${cmd}`);
        }
      },
    };
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

const calls = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls);

test("Mac panels, focus sync and distraction prompt work through the real bridge", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await expect(page.getByTestId("now-activity")).toContainText("Now: Visual Studio Code");
  await expect(page.getByTestId("since-break")).toContainText("52m since your last break");
  await expect(page.getByRole("list", { name: "Top sites" })).toContainText("youtube.com");
  await expect(page.getByTestId("active-total")).toHaveText(/\d+h \d+m/);
  await expect(page.getByRole("button", { name: "Allow…" })).toBeVisible();

  await page.getByLabel("What absolutely has to get done today?").fill("Launch landing page");
  await page.getByRole("button", { name: "Add goal" }).click();
  await page.getByLabel("New step for Launch landing page").fill("Write hero copy");
  await page.getByLabel("New step for Launch landing page").press("Enter");
  await page.getByRole("button", { name: "Start it" }).click();

  await expect.poll(async () => (await calls(page)).filter((c) => c.cmd === "set_focus").at(-1)?.args).toEqual({
    active: true,
    label: "Write hero copy",
  });

  await page.evaluate(() =>
    (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit("momentum://distraction", {
      appName: "Safari",
      site: "youtube.com",
      windowTitle: "Funny cats - YouTube",
      key: "youtube.com",
      blocked: false,
      focusLabel: "Write hero copy",
    }),
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Drifted to youtube.com");
  await page.screenshot({ path: "test-results/momentum-distraction.png" });
  await dialog.getByRole("button", { name: "Give me 5 minutes" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await calls(page)).some((c) => c.cmd === "snooze_guard" && c.args.minutes === 5)).toBe(true);
  expect((await calls(page)).some((c) => c.cmd === "release_window")).toBe(true);

  // "Allow this session" passes the site key to Rust.
  await page.evaluate(() =>
    (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit("momentum://distraction", {
      appName: "Google Chrome",
      site: "reddit.com",
      windowTitle: null,
      key: "reddit.com",
      blocked: true,
      focusLabel: "Write hero copy",
    }),
  );
  await expect(dialog).toContainText("Momentum hid it for you");
  await dialog.getByRole("button", { name: "Allow reddit.com this session" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await calls(page)).some((c) => c.cmd === "allow_for_session" && c.args.key === "reddit.com")).toBe(true);

  // Settings round-trip through set_config.
  await page.getByText("Focus guard & privacy").click();
  await page.getByRole("radio", { name: /Block/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const saved = (await calls(page)).filter((c) => c.cmd === "set_config").at(-1)?.args.config as { guardMode: string };
  expect(saved.guardMode).toBe("block");

  await page.getByText("Focus guard & privacy").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/momentum-mac-app.png", fullPage: true });
  expect(errors).toEqual([]);
});
