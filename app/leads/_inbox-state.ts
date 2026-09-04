import type { Lead } from "@/lib/supabase";
import type { LeadCounts } from "./_types";
import { isBookedLead, isPersonalLead, hasSmsDeliveryFailure } from "./_utils";

// Fields where the server generates its own value (timestamps), so "did the
// server confirm this edit?" is a truthy comparison, not strict equality.
const TRUTHY_MATCH_FIELDS = new Set<keyof Lead>(["deleted_at", "booked_at"]);

function serverConfirms(field: keyof Lead, serverValue: unknown, optimisticValue: unknown) {
  if (TRUTHY_MATCH_FIELDS.has(field)) {
    return Boolean(serverValue) === Boolean(optimisticValue);
  }

  return (serverValue ?? null) === (optimisticValue ?? null);
}

function countContribution(lead: Lead): LeadCounts {
  const visible = !lead.deleted_at && !isPersonalLead(lead);
  const booked = visible && isBookedLead(lead);
  const bookedValueCents = booked ? (lead.job_value_cents ?? 0) : 0;
  const bookedWithValue = booked && lead.job_value_cents ? 1 : 0;

  return {
    all: visible ? 1 : 0,
    new: visible && lead.status === "new" ? 1 : 0,
    contacted: visible && lead.status === "contacted" ? 1 : 0,
    booked: booked ? 1 : 0,
    dead: visible && lead.status === "dead" ? 1 : 0,
    trash: lead.deleted_at ? 1 : 0,
    personal: !lead.deleted_at && isPersonalLead(lead) ? 1 : 0,
    smsBlocked: visible && lead.status === "new" && lead.sms_status === "blocked_pre_send" ? 1 : 0,
    knownContactSkipped: visible && lead.sms_status === "skipped_known_contact" ? 1 : 0,
    actionable: visible && (lead.status === "new" || lead.status === "contacted") ? 1 : 0,
    smsIssues: visible && hasSmsDeliveryFailure(lead) ? 1 : 0,
    bookedValueCents,
    bookedWithValue,
  };
}

function applyCountDelta(counts: LeadCounts, before: Lead, after: Lead): LeadCounts {
  const previous = countContribution(before);
  const next = countContribution(after);

  return {
    all: counts.all - previous.all + next.all,
    new: counts.new - previous.new + next.new,
    contacted: counts.contacted - previous.contacted + next.contacted,
    booked: counts.booked - previous.booked + next.booked,
    dead: counts.dead - previous.dead + next.dead,
    trash: counts.trash - previous.trash + next.trash,
    personal: counts.personal - previous.personal + next.personal,
    smsBlocked: counts.smsBlocked - previous.smsBlocked + next.smsBlocked,
    knownContactSkipped: counts.knownContactSkipped - previous.knownContactSkipped + next.knownContactSkipped,
    actionable: counts.actionable - previous.actionable + next.actionable,
    smsIssues: counts.smsIssues - previous.smsIssues + next.smsIssues,
    bookedValueCents: counts.bookedValueCents - previous.bookedValueCents + next.bookedValueCents,
    bookedWithValue: counts.bookedWithValue - previous.bookedWithValue + next.bookedWithValue,
  };
}

export function applyCountDeltas(counts: LeadCounts, changes: Array<{ before: Lead; after: Lead }>): LeadCounts {
  return changes.reduce((nextCounts, change) => applyCountDelta(nextCounts, change.before, change.after), counts);
}

// Rebase pending counts onto the latest account totals and contact metadata.
export function applyPendingCounts(
  counts: LeadCounts,
  leads: Lead[],
  pendingLeadWrites: Map<string, Partial<Lead>>,
  pendingPhoneWrites: Map<string, Partial<Lead>>,
) {
  return applyCountDeltas(counts, leads.map((lead) => ({
    before: lead,
    after: { ...lead, ...pendingPhoneWrites.get(lead.phone), ...pendingLeadWrites.get(lead.id) },
  })));
}

// Reconcile server data against in-flight optimistic edits. Fields the
// server already reflects are confirmed and dropped; the rest stay applied
// on top so a stale refresh can never undo what the user just did.
export function applyPendingWrites(nextItems: Lead[], pendingLeadWrites: Map<string, Partial<Lead>>, pendingPhoneWrites: Map<string, Partial<Lead>>) {
  if (pendingLeadWrites.size === 0 && pendingPhoneWrites.size === 0) {
    return nextItems;
  }

  for (const [id, fields] of pendingLeadWrites) {
    const serverLead = nextItems.find((lead) => lead.id === id);
    if (!serverLead) continue;

    for (const key of Object.keys(fields) as Array<keyof Lead>) {
      if (serverConfirms(key, serverLead[key], fields[key])) {
        delete fields[key];
      }
    }

    if (Object.keys(fields).length === 0) pendingLeadWrites.delete(id);
  }

  for (const [phone, fields] of pendingPhoneWrites) {
    const phoneLeads = nextItems.filter((lead) => lead.phone === phone);
    if (phoneLeads.length === 0) continue;

    for (const key of Object.keys(fields) as Array<keyof Lead>) {
      if (phoneLeads.every((lead) => serverConfirms(key, lead[key], fields[key]))) {
        delete fields[key];
      }
    }

    if (Object.keys(fields).length === 0) pendingPhoneWrites.delete(phone);
  }

  const mergedItems = nextItems.map((lead) => {
    const phoneFields = pendingPhoneWrites.get(lead.phone);
    const leadFields = pendingLeadWrites.get(lead.id);
    if (!phoneFields && !leadFields) return lead;
    return { ...lead, ...phoneFields, ...leadFields };
  });

  // Server filtering owns membership. A missing row may have become Personal
  // or moved to another page; never reinsert it from stale local metadata.
  return mergedItems;
}
