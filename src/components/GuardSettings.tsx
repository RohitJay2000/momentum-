import { useEffect, useState } from "react";
import type { GuardMode, NativeApi, TrackerConfig } from "../platform/native";
import type { TrackerState } from "../platform/useTracker";

export const BREAK_OPTIONS = [0, 45, 60, 90, 120] as const;
export const AWAY_OPTIONS = [60, 120, 180, 300, 600] as const;
export const GRACE_OPTIONS = [0, 10, 30, 60, 120] as const;

export const toLines = (list: string[]) => list.join("\n");
export const fromLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

interface Props {
  api: NativeApi;
  tracker: TrackerState;
}

export function GuardSettings({ api, tracker }: Props) {
  const { config } = tracker;
  const [draft, setDraft] = useState<TrackerConfig | null>(config);
  const [apps, setApps] = useState("");
  const [sites, setSites] = useState("");
  const [keywords, setKeywords] = useState("");
  const [privateApps, setPrivateApps] = useState("");
  const [saved, setSaved] = useState<"idle" | "saved" | "failed">("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    if (!config) return;
    setDraft(config);
    setApps(toLines(config.distractingApps));
    setSites(toLines(config.distractingSites));
    setKeywords(toLines(config.distractingKeywords));
    setPrivateApps(toLines(config.privateApps));
  }, [config]);

  if (!api.available || !draft) return null;

  const set = <K extends keyof TrackerConfig>(key: K, value: TrackerConfig[K]) => {
    setDraft({ ...draft, [key]: value });
    setSaved("idle");
  };

  const save = async () => {
    const ok = await tracker.saveConfig({
      ...draft,
      distractingApps: fromLines(apps),
      distractingSites: fromLines(sites),
      distractingKeywords: fromLines(keywords),
      privateApps: fromLines(privateApps),
    });
    setSaved(ok ? "saved" : "failed");
  };

  const wipe = async () => {
    setConfirmDelete(false);
    try {
      await api.deleteActivity();
      setDeleted(true);
      void tracker.refresh();
    } catch {
      setDeleted(false);
    }
  };

  const modes: { value: GuardMode; label: string; hint: string }[] = [
    { value: "nudge", label: "Nudge", hint: "Bring Momentum forward with a gentle “back to it?”" },
    { value: "block", label: "Block", hint: "Nudge and hide the distracting app" },
    { value: "off", label: "Off", hint: "Never interrupt" },
  ];

  return (
    <details className="panel settings">
      <summary>
        <h2>Focus guard &amp; privacy</h2>
      </summary>
      <p className="muted small">
        The guard only acts while a step's focus timer is running.
      </p>

      <fieldset className="modes">
        <legend>When I drift during focus</legend>
        {modes.map((m) => (
          <label key={m.value} className="mode">
            <input
              type="radio"
              name="guard-mode"
              value={m.value}
              checked={draft.guardMode === m.value}
              onChange={() => set("guardMode", m.value)}
            />
            <span>
              <strong>{m.label}</strong> <span className="muted">— {m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="field">
        Step in after
        <select
          value={draft.distractionGraceSecs}
          onChange={(e) => set("distractionGraceSecs", Number(e.target.value))}
        >
          {[...new Set<number>([...GRACE_OPTIONS, draft.distractionGraceSecs])].sort((a, b) => a - b).map((s) => (
            <option key={s} value={s}>
              {s === 0 ? "Immediately" : s < 60 ? `${s} seconds on a distraction` : `${s / 60} min on a distraction`}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Distracting sites <span className="muted">(one per line, e.g. youtube.com, covers subdomains)</span>
        <textarea rows={4} value={sites} onChange={(e) => { setSites(e.target.value); setSaved("idle"); }} />
      </label>
      <label className="field">
        Distracting apps <span className="muted">(name or bundle ID, one per line)</span>
        <textarea rows={3} value={apps} onChange={(e) => { setApps(e.target.value); setSaved("idle"); }} />
      </label>
      <label className="field">
        Window words <span className="muted">(for browsers Momentum can't read, like Firefox)</span>
        <textarea rows={3} value={keywords} onChange={(e) => { setKeywords(e.target.value); setSaved("idle"); }} />
      </label>
      <label className="field">
        Never track <span className="muted">(apps that are never recorded, e.g. password managers)</span>
        <textarea rows={3} value={privateApps} onChange={(e) => { setPrivateApps(e.target.value); setSaved("idle"); }} />
      </label>

      <div className="field-row">
        <label className="field">
          Break reminder
          <select value={draft.breakAfterMin} onChange={(e) => set("breakAfterMin", Number(e.target.value))}>
            {[...new Set<number>([...BREAK_OPTIONS, draft.breakAfterMin])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Off" : `After ${m} min`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Count me away after
          <select value={draft.idleThresholdSecs} onChange={(e) => set("idleThresholdSecs", Number(e.target.value))}>
            {[...new Set<number>([...AWAY_OPTIONS, draft.idleThresholdSecs])].sort((a, b) => a - b).map((s) => (
              <option key={s} value={s}>
                {s < 60 ? `${s} sec` : `${Math.round(s / 60)} min`} idle
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="check-row">
        <input type="checkbox" checked={draft.trackUrls} onChange={(e) => set("trackUrls", e.target.checked)} />
        Track websites in Safari &amp; Chrome-based browsers{" "}
        <span className="muted">(only the site name is saved; macOS asks once per browser)</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={draft.recordTitles} onChange={(e) => set("recordTitles", e.target.checked)} />
        Save window titles in my history <span className="muted">(off = only app names are saved)</span>
      </label>

      <div className="settings-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          Save settings
        </button>
        {saved === "saved" && <span className="ok-text" role="status">Saved</span>}
        {saved === "failed" && <span className="warn-text" role="alert">Couldn't save</span>}
      </div>

      <div className="danger-zone">
        {confirmDelete ? (
          <>
            <span>Delete all recorded activity? Goals and settings are kept.</span>
            <button type="button" className="btn btn-danger" onClick={() => void wipe()}>
              Delete activity
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => { setConfirmDelete(true); setDeleted(false); }}>
            Delete my activity history…
          </button>
        )}
        {deleted && <span className="ok-text" role="status">Activity deleted</span>}
      </div>
    </details>
  );
}
