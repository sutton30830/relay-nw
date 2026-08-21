// Turns a settings change into human-readable audit entries. The SMS master
// switch — the highest-stakes control in the product — always gets its own
// explicit entry; every other changed field is rolled into one "Updated …"
// summary so the log reads cleanly instead of one row per keystroke.
//
// Pure and dependency-free so the diffing is unit-testable.

export type AuditDraft = { action: string; summary: string };

export type AuditableSettings = {
  smsEnabled?: boolean;
  businessName?: string;
  ownerPhoneNumber?: string;
  ownerEmail?: string | null;
  schedulingUrl?: string | null;
  smsTemplate?: string | null;
  quickReplyTemplates?: string[] | null;
  missedCallVoiceMessage?: string | null;
  missedCallGreetingAudioUrl?: string | null;
  dialTimeoutSeconds?: number;
  voicemailMaxSeconds?: number;
  missedCallSmsCooldownHours?: number;
  typicalJobValueCents?: number | null;
  notificationPreferences?: Record<string, unknown>;
};

// Order here is the order changes are listed in the summary.
const FIELD_LABELS: Array<[keyof AuditableSettings, string]> = [
  ["businessName", "business name"],
  ["ownerPhoneNumber", "owner phone"],
  ["ownerEmail", "owner email"],
  ["schedulingUrl", "scheduling link"],
  ["smsTemplate", "missed-call text"],
  ["quickReplyTemplates", "quick replies"],
  ["missedCallVoiceMessage", "voicemail greeting"],
  ["missedCallGreetingAudioUrl", "greeting recording"],
  ["dialTimeoutSeconds", "ring time"],
  ["voicemailMaxSeconds", "max voicemail length"],
  ["missedCallSmsCooldownHours", "text cooldown"],
  ["typicalJobValueCents", "typical job value"],
  ["notificationPreferences", "notification preferences"],
];

function valuesEqual(a: unknown, b: unknown): boolean {
  if (
    Array.isArray(a) ||
    Array.isArray(b) ||
    (a !== null && typeof a === "object") ||
    (b !== null && typeof b === "object")
  ) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  }
  // Treat null/undefined as the same "empty" so clearing a field once reads as
  // one change, not a null-vs-undefined phantom.
  return (a ?? null) === (b ?? null);
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// `after` only carries the fields that were actually submitted (undefined = not
// touched), so a partial update never looks like it cleared everything else.
export function diffSettingsForAudit(before: AuditableSettings, after: AuditableSettings): AuditDraft[] {
  const events: AuditDraft[] = [];

  if (typeof after.smsEnabled === "boolean" && after.smsEnabled !== before.smsEnabled) {
    events.push(
      after.smsEnabled
        ? { action: "texting.enabled", summary: "Turned automatic texting ON" }
        : { action: "texting.disabled", summary: "Turned automatic texting OFF" },
    );
  }

  const changedLabels: string[] = [];
  for (const [key, label] of FIELD_LABELS) {
    if (typeof after[key] === "undefined") continue;
    if (!valuesEqual(before[key], after[key])) changedLabels.push(label);
  }
  if (changedLabels.length > 0) {
    events.push({ action: "settings.updated", summary: `Updated ${joinList(changedLabels)}` });
  }

  return events;
}
