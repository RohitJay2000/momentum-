import { useEffect, useRef, useState } from "react";
import { MAX_TITLE_LENGTH } from "../domain/types";

interface Props {
  value: string;
  label: string;
  onSave: (next: string) => void;
  className?: string;
}

/** Text that turns into an input when clicked. Enter or blur saves, Escape cancels. */
export function EditableText({ value, label, onSave, className }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`editable ${className ?? ""}`}
        title="Click to rename"
        aria-label={`Rename ${label}: ${value}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== value) onSave(draft);
  };

  return (
    <input
      ref={inputRef}
      className={`editable-input ${className ?? ""}`}
      aria-label={`New name for ${label}`}
      value={draft}
      maxLength={MAX_TITLE_LENGTH}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}
