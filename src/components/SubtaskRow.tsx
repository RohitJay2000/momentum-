import { formatClock, formatMinutes } from "../domain/format";
import { subtaskWorkMinutes, trackedMs } from "../domain/metrics";
import { ESTIMATE_OPTIONS, type Subtask } from "../domain/types";
import { EditableText } from "./EditableText";

interface Props {
  subtask: Subtask;
  now: number;
  isNext: boolean;
  onToggle: () => void;
  onStart: () => void;
  onPause: () => void;
  onRename: (title: string) => void;
  onEstimate: (minutes: number) => void;
  onDelete: () => void;
}

export function estimateOptions(current: number): number[] {
  const options: number[] = [...ESTIMATE_OPTIONS];
  if (!options.includes(current)) options.push(current);
  return options.sort((a, b) => a - b);
}

export function SubtaskRow({
  subtask,
  now,
  isNext,
  onToggle,
  onStart,
  onPause,
  onRename,
  onEstimate,
  onDelete,
}: Props) {
  const running = subtask.timerStartedAt !== null;
  const tracked = trackedMs(subtask, now);

  return (
    <li
      className={`subtask ${subtask.done ? "is-done" : ""} ${running ? "is-running" : ""} ${isNext ? "is-next" : ""}`}
    >
      <input
        type="checkbox"
        className="check"
        checked={subtask.done}
        onChange={onToggle}
        aria-label={`${subtask.done ? "Mark not done" : "Mark done"}: ${subtask.title}`}
      />
      <div className="subtask-main">
        <EditableText value={subtask.title} label="subtask" onSave={onRename} className="subtask-title" />
        <div className="subtask-meta">
          {subtask.done ? (
            <span className="meta-chip done-chip">
              {formatMinutes(subtaskWorkMinutes(subtask, now))} real work
            </span>
          ) : (
            <label className="estimate">
              <span className="visually-hidden">Estimate for {subtask.title}</span>
              <select
                value={subtask.estimateMin}
                onChange={(e) => onEstimate(Number(e.target.value))}
                aria-label={`Estimate for ${subtask.title}`}
              >
                {estimateOptions(subtask.estimateMin).map((m) => (
                  <option key={m} value={m}>
                    ~{formatMinutes(m)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!subtask.done && (tracked > 0 || running) && (
            <span className="meta-chip timer-chip" aria-live="off">
              {formatClock(tracked)}
            </span>
          )}
        </div>
      </div>
      <div className="subtask-actions">
        {!subtask.done &&
          (running ? (
            <button type="button" className="btn btn-timer is-on" onClick={onPause} aria-label={`Pause timer for ${subtask.title}`}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn btn-timer" onClick={onStart} aria-label={`Start focus timer for ${subtask.title}`}>
              Start
            </button>
          ))}
        <button type="button" className="btn-icon" onClick={onDelete} aria-label={`Delete subtask ${subtask.title}`}>
          ×
        </button>
      </div>
    </li>
  );
}
