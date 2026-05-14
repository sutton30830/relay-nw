"use client";

import { useEffect, useState } from "react";
import type { LeadStatus, ReplyPriorityOverride } from "@/lib/supabase";
import { STATUS_LABELS, STATUS_OPTIONS } from "../_constants";
import { centsToInputValue, dollarsToCents } from "../_utils";

export function PriorityControl({
  value,
  onChange,
}: {
  value: ReplyPriorityOverride;
  onChange: (value: ReplyPriorityOverride) => void;
}) {
  const options: Array<{ label: string; value: ReplyPriorityOverride }> = [
    { label: "Auto detect", value: null },
    { label: "Fast reply", value: "fast" },
    { label: "Today", value: "today" },
    { label: "Normal", value: "normal" },
  ];

  return (
    <div className="priority-control">
      <span className="t-eyebrow">Reply priority</span>
      <div className="priority-control__options" role="group" aria-label="Reply priority">
        {options.map((option) => {
          const selected = value === option.value;

          return (
            <button
              key={option.label}
              type="button"
              className={`priority-control__option ${selected ? "priority-control__option--active" : ""}`}
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StatusControl({
  status,
  onChange,
}: {
  status: LeadStatus;
  onChange: (status: LeadStatus) => void;
}) {
  return (
    <div className="lead-card__status-ctrl">
      {STATUS_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={`status-seg ${status === option ? "status-seg--on" : ""}`}
          onClick={() => onChange(option)}
        >
          {STATUS_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

export function BookedToggle({
  booked,
  onChange,
}: {
  booked: boolean;
  onChange: (booked: boolean) => void;
}) {
  return (
    <label className={`booked-toggle ${booked ? "booked-toggle--on" : ""}`}>
      <input
        type="checkbox"
        checked={booked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Booked job</span>
    </label>
  );
}

export function BookedValueInput({
  valueCents,
  onSave,
  compact = false,
}: {
  valueCents: number | null;
  onSave: (jobValueCents: number | null) => void;
  compact?: boolean;
}) {
  const [value, setValue] = useState(centsToInputValue(valueCents));

  useEffect(() => {
    setValue(centsToInputValue(valueCents));
  }, [valueCents]);

  function saveValue() {
    onSave(dollarsToCents(value));
  }

  return (
    <label className={`money-field ${compact ? "money-field--compact" : ""}`}>
      <span>$</span>
      <input
        inputMode="numeric"
        placeholder="0"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={saveValue}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        aria-label="Estimated booked job value"
      />
    </label>
  );
}
