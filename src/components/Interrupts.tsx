import { useEffect, useRef } from "react";
import type { BreakEvent, DistractionEvent } from "../platform/native";

export type Interrupt =
  | { kind: "distraction"; event: DistractionEvent }
  | { kind: "break"; event: BreakEvent };

interface Props {
  interrupt: Interrupt;
  onBackToWork: () => void;
  onSnooze: () => void;
  /** Allow this site/app for the rest of the focus session. */
  onAllow: (key: string) => void;
  onTakeBreak: () => void;
  onKeepGoing: () => void;
}

/** A calm, dismissible prompt. Never a wall: one tap gets you out. */
export function InterruptDialog({ interrupt, onBackToWork, onSnooze, onAllow, onTakeBreak, onKeepGoing }: Props) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), [interrupt]);

  const dismiss = interrupt.kind === "distraction" ? onBackToWork : onKeepGoing;

  return (
    <div
      className="overlay"
      onKeyDown={(e) => {
        if (e.key === "Escape") dismiss();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="interrupt-title">
        {interrupt.kind === "distraction" ? (
          <>
            <h2 id="interrupt-title">Drifted to {interrupt.event.site ?? interrupt.event.appName}</h2>
            <p>
              {interrupt.event.focusLabel ? (
                <>
                  You're focusing on <strong>“{interrupt.event.focusLabel}”</strong>.
                </>
              ) : (
                "You're in a focus session."
              )}{" "}
              {interrupt.event.blocked ? "Momentum hid it for you." : "Want to head back?"}
            </p>
            <div className="dialog-actions">
              <button ref={primary} type="button" className="btn btn-primary" onClick={onBackToWork}>
                Back to it
              </button>
              <button type="button" className="btn btn-ghost" onClick={onSnooze}>
                Give me 5 minutes
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => onAllow(interrupt.event.key)}>
                Allow {interrupt.event.site ?? interrupt.event.appName} this session
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="interrupt-title">You've been going for {interrupt.event.activeMinutes} minutes</h2>
            <p>A 5-minute break now protects the rest of your day. Stand up, drink water, look far away.</p>
            <div className="dialog-actions">
              <button ref={primary} type="button" className="btn btn-primary" onClick={onTakeBreak}>
                Take a break
              </button>
              <button type="button" className="btn btn-ghost" onClick={onKeepGoing}>
                Keep going
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
