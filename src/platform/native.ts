/**
 * Bridge to the Rust side of the Mac app. In a plain browser (dev/tests) these are no-ops,
 * so the planner works everywhere and tracking features appear only inside the app.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type GuardMode = "off" | "nudge" | "block";
export type Category = "focus" | "meeting" | "communication" | "distraction" | "other";

export interface TrackerConfig {
  trackingEnabled: boolean;
  recordTitles: boolean;
  /** Read the active browser tab; only the site name is stored. */
  trackUrls: boolean;
  guardMode: GuardMode;
  /** Seconds on a distraction before the guard steps in (0 = immediately). */
  distractionGraceSecs: number;
  distractingApps: string[];
  /** Domains, matched with subdomains (youtube.com covers m.youtube.com). */
  distractingSites: string[];
  /** Title words, used only when the site isn't known (e.g. Firefox). */
  distractingKeywords: string[];
  /** Never recorded at all. */
  privateApps: string[];
  idleThresholdSecs: number;
  breakAfterMin: number;
}

export interface CurrentActivity {
  appName: string;
  bundleId: string;
  windowTitle: string | null;
  site: string | null;
  category: Category;
}

export interface TrackerStatus {
  supported: boolean;
  accessibilityTrusted: boolean;
  trackingEnabled: boolean;
  idle: boolean;
  focusActive: boolean;
  snoozedUntilMs: number | null;
  /** Start of the current stretch without a break. */
  activeSinceMs: number | null;
  current: CurrentActivity | null;
}

export interface CategoryTotals {
  focusMs: number;
  meetingMs: number;
  communicationMs: number;
  distractionMs: number;
  otherMs: number;
}

export interface AppTotal {
  appName: string;
  bundleId: string;
  category: Category;
  ms: number;
}

export interface SiteTotal {
  host: string;
  category: Category;
  ms: number;
}

export interface DaySummary {
  date: string;
  activeMs: number;
  totals: CategoryTotals;
  topApps: AppTotal[];
  topSites: SiteTotal[];
  hours: CategoryTotals[];
  firstMs: number | null;
  lastMs: number | null;
}

export interface SessionRecap {
  startMs: number;
  endMs: number;
  trackedMs: number;
  totals: CategoryTotals;
  /** 0–100, or null if nothing was tracked. */
  focusPercent: number | null;
  topApps: AppTotal[];
  topSites: SiteTotal[];
  /** Where the time went: sites for browser time, apps otherwise. */
  topPlaces: { name: string; category: Category; ms: number }[];
}

export interface DistractionEvent {
  appName: string;
  site: string | null;
  windowTitle: string | null;
  /** Pass to allowForSession. */
  key: string;
  blocked: boolean;
  focusLabel: string | null;
}

export interface BreakEvent {
  activeMinutes: number;
}

export interface IdleEvent {
  sinceMs: number;
}

export const EVENTS = {
  distraction: "momentum://distraction",
  break: "momentum://break",
  idle: "momentum://idle",
  storageError: "momentum://storage-error",
} as const;

/** True only inside the Tauri app window. */
export function isNative(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface NativeApi {
  available: boolean;
  getStatus(): Promise<TrackerStatus>;
  getConfig(): Promise<TrackerConfig>;
  setConfig(config: TrackerConfig): Promise<TrackerConfig>;
  getDaySummary(date: string): Promise<DaySummary>;
  setFocus(active: boolean, label: string | null): Promise<void>;
  snoozeGuard(minutes: number): Promise<void>;
  takeBreak(): Promise<void>;
  allowForSession(key: string): Promise<void>;
  getSessionRecap(startMs: number, endMs: number): Promise<SessionRecap>;
  /** Stop keeping the window on top after a distraction prompt. */
  releaseWindow(): Promise<void>;
  requestAccessibility(): Promise<boolean>;
  deleteActivity(): Promise<void>;
  onDistraction(cb: (e: DistractionEvent) => void): Promise<UnlistenFn>;
  onBreak(cb: (e: BreakEvent) => void): Promise<UnlistenFn>;
  onIdle(cb: (e: IdleEvent) => void): Promise<UnlistenFn>;
  onStorageError(cb: (message: string) => void): Promise<UnlistenFn>;
}

const noop: UnlistenFn = () => {};
const unavailable = () => Promise.reject(new Error("Only available in the Momentum Mac app"));

export const browserApi: NativeApi = {
  available: false,
  getStatus: unavailable,
  getConfig: unavailable,
  setConfig: unavailable,
  getDaySummary: unavailable,
  setFocus: () => Promise.resolve(),
  snoozeGuard: () => Promise.resolve(),
  takeBreak: () => Promise.resolve(),
  allowForSession: () => Promise.resolve(),
  getSessionRecap: unavailable,
  releaseWindow: () => Promise.resolve(),
  requestAccessibility: () => Promise.resolve(false),
  deleteActivity: unavailable,
  onDistraction: () => Promise.resolve(noop),
  onBreak: () => Promise.resolve(noop),
  onIdle: () => Promise.resolve(noop),
  onStorageError: () => Promise.resolve(noop),
};

export const tauriApi: NativeApi = {
  available: true,
  getStatus: () => invoke<TrackerStatus>("get_status"),
  getConfig: () => invoke<TrackerConfig>("get_config"),
  setConfig: (config) => invoke<TrackerConfig>("set_config", { config }),
  getDaySummary: (date) => invoke<DaySummary>("get_day_summary", { date }),
  setFocus: (active, label) => invoke<void>("set_focus", { active, label }),
  snoozeGuard: (minutes) => invoke<void>("snooze_guard", { minutes }),
  takeBreak: () => invoke<void>("take_break"),
  allowForSession: (key) => invoke<void>("allow_for_session", { key }),
  getSessionRecap: (startMs, endMs) => invoke<SessionRecap>("get_session_recap", { startMs, endMs }),
  releaseWindow: () => invoke<void>("release_window"),
  requestAccessibility: () => invoke<boolean>("request_accessibility"),
  deleteActivity: () => invoke<void>("delete_activity"),
  onDistraction: (cb) => listen<DistractionEvent>(EVENTS.distraction, (e) => cb(e.payload)),
  onBreak: (cb) => listen<BreakEvent>(EVENTS.break, (e) => cb(e.payload)),
  onIdle: (cb) => listen<IdleEvent>(EVENTS.idle, (e) => cb(e.payload)),
  onStorageError: (cb) => listen<string>(EVENTS.storageError, (e) => cb(e.payload)),
};

export function defaultApi(): NativeApi {
  return isNative() ? tauriApi : browserApi;
}
