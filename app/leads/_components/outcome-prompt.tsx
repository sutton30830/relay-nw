"use client";

import { Icon } from "@/components/icon";

export type OutcomePromptStage = "reached" | "outcome";

// The two questions that turn a call-back into a number on the Reports page.
// Asked at the moment they're answerable: right after the owner taps Call
// back ("did you reach them?") and right after a lead becomes Contacted ("did
// it become a job?"). Session-only; the Status menu remains the manual path.
export function OutcomePrompt({
  stage,
  onReached,
  onBooked,
  onDismiss,
}: {
  stage: OutcomePromptStage;
  onReached: () => void;
  onBooked: () => void;
  onDismiss: () => void;
}) {
  const reached = stage === "reached";

  return (
    <div className="outcome-prompt" role="group" aria-label={reached ? "Did you reach them?" : "Did this become a job?"}>
      <p className="outcome-prompt__question">
        <Icon name={reached ? "phone" : "star"} size={13} />
        {reached ? "Did you reach them?" : "Did this become a job?"}
      </p>
      <div className="outcome-prompt__actions">
        {reached ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={onReached}>
            Yes, mark contacted
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" type="button" onClick={onBooked}>
            Yes, booked
          </button>
        )}
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDismiss}>
          Not yet
        </button>
      </div>
    </div>
  );
}
