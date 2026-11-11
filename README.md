# Momentum

A privacy-first Mac app for ADHD brains: **2–3 non-negotiable goals a day**, broken into small
steps, plus automatic background tracking, a focus guard that catches drift, and the one number
that matters: **the most real work you can do *consistently***.

Everything stays on your Mac. No account, no cloud, nothing sent anywhere.

## What it does

### Daily non-negotiables
- Pick up to **3 goals** for today (2–3 is the sweet spot; the app won't let you overload).
- Split each goal into **small steps** with a minute estimate. Finishing every step finishes the goal.
- **Up next** always shows the single next tiny step, with a one-tap **Start it**.
- **Momentum**: a progress bar, a count of winning days, and a run of consecutive days with every
  goal done. Missing a day never shows red or "streak lost"; an unfinished today doesn't break
  yesterday's run.
- **Carry over**: unfinished goals from your last planned day can come forward with only their
  open steps.

### War Map (your year at a glance)
Based on the War Map Calendar spreadsheet, cut to the 20% that does 80% of the work:
- **The whole year on one screen.** Every day is coloured **automatically** from what you actually
  did: green = every non-negotiable done, amber = some done, grey = planned. Nothing to fill in.
- **Up to 3 main objectives per month**, shown at the top of Today so daily goals have a reason.
- **Key dates** (launch, deadline, trip) with a countdown on Today ("Launch, in 12 days"), which helps
  with time blindness.

Left out on purpose: per-day note rows, monthly notes and a custom colour key. They're manual upkeep,
which tends to get dropped.

### Focus timer = real work
- Each step has an optional focus timer (one runs at a time).
- Timed steps count their **real minutes**; finished untimed steps count their estimate.
- A forgotten timer is capped at 3 hours. When you step away from the Mac, the timer is
  **paused back to the moment you stopped typing**.

### Your consistent capacity
After 5 planned days, Momentum shows the amount of real work you reached on **at least 80% of
your last 14 planned days**: your sustainable daily capacity, not your best day.
- Plan more than ~15% above it and it suggests moving a step to tomorrow.
- Finish everything 5 days running and it suggests a ~10% stretch.

### Background tracking (like Rize, but private)
- Samples the frontmost app every 5 seconds and builds a timeline: **Focus, Communication,
  Distraction, Other**, an hour-by-hour view, and top apps.
- Idle detection: after 3 minutes without input you're counted as away.
- Keeps running when you close the window (quit with ⌘Q, reopen from the Dock).
- Pause tracking any time; delete all history with one button.
- By default only **app names** are saved. Window titles are read in memory to spot distracting
  tabs and are saved only if you turn that on.

### Focus guard and break reminders
While a step's timer is running, switching to a distraction (an app like Discord, or a tab
whose title contains words like *YouTube* or *Reddit*) triggers:
- **Nudge** (default): Momentum comes forward and asks "Back to it?", with a "Give me 5 minutes"
  snooze.
- **Block**: also hides the distracting app.
- **Off**: never interrupts.

After 90 minutes of continuous activity (configurable), it reminds you to take a break, which
helps with hyperfocus.

## Install on your Mac

1. Download the `.dmg` from the repo's **Releases** page (newest release at the top). It's a
   universal build for Apple Silicon and Intel. Each CI run's **Momentum-macOS-dmg** artifact
   has the same file.
2. Open the `.dmg` and drag **Momentum** into **Applications**.
3. The app isn't notarized by Apple yet, so the first launch is blocked. Either:
   - open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, or
   - run once in Terminal:
     ```bash
     xattr -dr com.apple.quarantine /Applications/Momentum.app
     ```
4. In the app, click **Allow…** under *Today on your Mac*, then turn Momentum on in
   **System Settings → Privacy & Security → Accessibility**. This is needed only for
   window titles (spotting YouTube in a browser tab). App tracking and app blocking work without it.

> After installing a **new build**, macOS may need Accessibility re-enabled (remove Momentum from
> the list and add it again), because unsigned builds get a new identity each time.

### Build it yourself

Requires Node 22+, Rust (stable) and Xcode Command Line Tools.

```bash
npm ci
npm run tauri dev      # run with hot reload
npm run tauri build    # produces Momentum.app and a .dmg in src-tauri/target/release/bundle/
```

## Where your data lives

| What | Where |
| --- | --- |
| Goals, steps, timers | The app's local WebView storage on this Mac |
| Activity timeline | `~/Library/Application Support/com.rohitjay.momentum/activity/YYYY-MM-DD.jsonl` |
| Tracker settings | `~/Library/Application Support/com.rohitjay.momentum/config.json` |

## Development

```bash
npm run typecheck                                   # TypeScript
npm test                                            # unit + component tests (Vitest)
npm run test:e2e                                    # browser end-to-end tests (Playwright)
cargo test --manifest-path src-tauri/Cargo.toml     # Rust tracker, guard, storage tests
```

- `src/domain/`: goals, timers, capacity math (pure, fully tested)
- `src/components/`: React UI
- `src/platform/`: bridge to the Rust side (inert in a normal browser)
- `src-tauri/src/domain/`: tracking aggregation, focus guard, break reminders, storage, summaries
  (pure Rust, tested on any OS)
- `src-tauri/src/platform/macos.rs`: macOS APIs (NSWorkspace, CGEventSource, Accessibility)

CI (`.github/workflows/ci.yml`) runs every test on macOS, including WebKit end-to-end tests,
then builds and uploads the universal `.dmg`.

## Roadmap ideas
- On-device AI (local model) to group activity into projects and write a kind end-of-day summary
- Website blocking at the network level
- Notifications and a menu-bar timer
