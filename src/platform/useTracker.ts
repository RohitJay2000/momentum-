import { useCallback, useEffect, useRef, useState } from "react";
import type { DaySummary, NativeApi, TrackerConfig, TrackerStatus } from "./native";

export const TRACKER_POLL_MS = 15_000;

export interface TrackerState {
  status: TrackerStatus | null;
  summary: DaySummary | null;
  config: TrackerConfig | null;
  error: string | null;
  refresh: () => Promise<void>;
  saveConfig: (next: TrackerConfig) => Promise<boolean>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Polls the Mac tracker for status and today's summary. Inert outside the app. */
export function useTracker(api: NativeApi, today: string): TrackerState {
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [config, setConfig] = useState<TrackerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!api.available) return;
    try {
      const [st, sum] = await Promise.all([api.getStatus(), api.getDaySummary(today)]);
      if (!alive.current) return;
      setStatus(st);
      setSummary(sum);
      setError(null);
    } catch (e) {
      if (alive.current) setError(message(e));
    }
  }, [api, today]);

  useEffect(() => {
    alive.current = true;
    if (!api.available) return;
    api
      .getConfig()
      .then((c) => alive.current && setConfig(c))
      .catch((e: unknown) => alive.current && setError(message(e)));
    void refresh();
    const id = window.setInterval(() => void refresh(), TRACKER_POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [api, refresh]);

  const saveConfig = useCallback(
    async (next: TrackerConfig) => {
      try {
        const saved = await api.setConfig(next);
        if (alive.current) {
          setConfig(saved);
          setError(null);
        }
        void refresh();
        return true;
      } catch (e) {
        if (alive.current) setError(message(e));
        return false;
      }
    },
    [api, refresh],
  );

  return { status, summary, config, error, refresh, saveConfig };
}
