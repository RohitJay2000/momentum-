import { useState, type FormEvent } from "react";
import { formatMinutes } from "../domain/format";
import { isGoalDone, subtaskPlannedMinutes } from "../domain/metrics";
import { DEFAULT_ESTIMATE, ESTIMATE_OPTIONS, MAX_TITLE_LENGTH, type Goal } from "../domain/types";
import { EditableText } from "./EditableText";
import { SubtaskRow } from "./SubtaskRow";

export interface GoalHandlers {
  onRenameGoal: (goalId: string, title: string) => void;
  onDeleteGoal: (goalId: string) => void;
  onAddSubtask: (goalId: string, title: string, estimateMin: number) => void;
  onToggle: (goalId: string, subtaskId: string) => void;
  onStart: (goalId: string, subtaskId: string) => void;
  onPause: () => void;
  onRenameSubtask: (goalId: string, subtaskId: string, title: string) => void;
  onEstimate: (goalId: string, subtaskId: string, minutes: number) => void;
  onDeleteSubtask: (goalId: string, subtaskId: string) => void;
}

interface Props extends GoalHandlers {
  goal: Goal;
  index: number;
  now: number;
  nextSubtaskId: string | null;
}

export function GoalCard({ goal, index, now, nextSubtaskId, ...h }: Props) {
  const [title, setTitle] = useState("");
  const [estimate, setEstimate] = useState<number>(DEFAULT_ESTIMATE);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const done = isGoalDone(goal);
  const doneCount = goal.subtasks.filter((s) => s.done).length;
  const total = goal.subtasks.length;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const plannedMin = goal.subtasks.reduce((sum, s) => sum + subtaskPlannedMinutes(s, now), 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    h.onAddSubtask(goal.id, title, estimate);
    setTitle("");
  };

  return (
    <article className={`goal ${done ? "is-done" : ""}`} aria-label={`Goal ${index + 1}: ${goal.title}`}>
      <header className="goal-head">
        <span className="goal-number" aria-hidden="true">
          {done ? "✓" : index + 1}
        </span>
        <div className="goal-title-wrap">
          <EditableText
            value={goal.title}
            label="goal"
            onSave={(t) => h.onRenameGoal(goal.id, t)}
            className="goal-title"
          />
          <div className="goal-sub">
            {total === 0
              ? "No steps yet"
              : `${doneCount} of ${total} ${total === 1 ? "step" : "steps"} · ~${formatMinutes(plannedMin)}`}
            {done && <span className="badge-done">Done</span>}
          </div>
        </div>
        <div className="goal-delete">
          {confirmDelete ? (
            <>
              <button type="button" className="btn btn-danger" onClick={() => h.onDeleteGoal(goal.id)}>
                Delete goal
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-icon"
              aria-label={`Delete goal ${goal.title}`}
              onClick={() => setConfirmDelete(true)}
            >
              ×
            </button>
          )}
        </div>
      </header>

      <div
        className="progress"
        role="progressbar"
        aria-label={`${goal.title} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      {total === 0 && (
        <p className="hint">Break it into small steps — each one something you could start in 2 minutes.</p>
      )}

      {total > 0 && (
        <ul className="subtasks">
          {goal.subtasks.map((s) => (
            <SubtaskRow
              key={s.id}
              subtask={s}
              now={now}
              isNext={s.id === nextSubtaskId}
              onToggle={() => h.onToggle(goal.id, s.id)}
              onStart={() => h.onStart(goal.id, s.id)}
              onPause={h.onPause}
              onRename={(t) => h.onRenameSubtask(goal.id, s.id, t)}
              onEstimate={(m) => h.onEstimate(goal.id, s.id, m)}
              onDelete={() => h.onDeleteSubtask(goal.id, s.id)}
            />
          ))}
        </ul>
      )}

      <form className="add-subtask" onSubmit={submit}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a small step…"
          maxLength={MAX_TITLE_LENGTH}
          aria-label={`New step for ${goal.title}`}
        />
        <select
          value={estimate}
          onChange={(e) => setEstimate(Number(e.target.value))}
          aria-label={`Estimate for new step in ${goal.title}`}
        >
          {ESTIMATE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              ~{formatMinutes(m)}
            </option>
          ))}
        </select>
        <button type="submit" className="btn" disabled={!title.trim()}>
          Add step
        </button>
      </form>
    </article>
  );
}
