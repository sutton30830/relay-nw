"use client";

import { Icon } from "@/components/icon";
import type { Lead, LeadStatus } from "@/lib/supabase";
import type { ReplyPriority } from "../_types";
import { STATUS_LABELS } from "../_constants";
import { formatCurrency, isBookedLead, sourceLabel } from "../_utils";

export function StatusPill({ status }: { status: LeadStatus }) {
  return <span className={`chip status-pill--${status}`}>{STATUS_LABELS[status]}</span>;
}

export function BookedBadge({ lead }: { lead: Lead }) {
  if (!isBookedLead(lead)) return null;

  return (
    <span className="chip chip-good">
      {lead.job_value_cents ? `${formatCurrency(lead.job_value_cents)} booked` : "Booked job"}
    </span>
  );
}

export function SourceBadge({ source }: { source: Lead["source"] }) {
  if (source === "missed_call") return null;

  return (
    <span className="chip source-badge" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
      <Icon name="inbox" size={12} />
      {sourceLabel(source)}
    </span>
  );
}

export function SmsBadge({ lead }: { lead: Lead }) {
  if (!lead.sms_status || lead.source !== "missed_call") return null;

  if (lead.sms_status === "failed" || lead.sms_status === "undelivered") {
    return <span className="chip chip-danger sms-badge sms-badge--failed"><Icon name="alertTriangle" size={12} /> SMS failed</span>;
  }
  if (lead.sms_status === "delivered") {
    return <span className="chip chip-good sms-badge sms-badge--delivered"><Icon name="checkDouble" size={12} /> SMS delivered</span>;
  }
  if (lead.sms_status === "sent") {
    return <span className="chip chip-good sms-badge sms-badge--sent"><Icon name="checkDouble" size={12} /> SMS sent</span>;
  }
  if (lead.sms_status === "skipped_opt_out") {
    return <span className="chip chip-warn sms-badge sms-badge--optout"><Icon name="shield" size={12} /> Opted out</span>;
  }
  if (lead.sms_status === "skipped_recent") {
    return <span className="chip sms-badge sms-badge--recent"><Icon name="clock" size={12} /> Recently texted</span>;
  }
  if (lead.sms_status === "skipped_disabled") {
    return <span className="chip chip-warn sms-badge sms-badge--disabled"><Icon name="shield" size={12} /> SMS off</span>;
  }
  return <span className="chip chip-warn sms-badge sms-badge--pending"><Icon name="clock" size={12} /> SMS pending</span>;
}

export function VoicemailBadge({ lead }: { lead: Lead }) {
  if (!lead.recording_sid) return null;

  return (
    <span className="chip chip-good">
      <Icon name="message" size={12} /> Voicemail
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: ReplyPriority }) {
  if (priority.level === "normal") return null;

  return (
    <span className={`chip priority-badge priority-badge--${priority.level}`}>
      <Icon name={priority.level === "fast" ? "alertTriangle" : "clock"} size={12} />
      {priority.label}
    </span>
  );
}
