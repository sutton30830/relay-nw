import type { ContactClassification, ContactSmsPolicy, KnownContact, Lead } from "./supabase/types";

export type ContactDetails = Pick<KnownContact, "id" | "phone" | "display_name" | "classification" | "auto_sms_policy" | "version">;

export class ContactRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function contactRequest<T>(url: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method, signal, cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new ContactRequestError(data.error || "Could not save contact preferences.", response.status);
  return data as T;
}

export function contactFromLead(lead: Lead): ContactDetails | null {
  return lead.contact_id && lead.contact_version && lead.contact_classification && lead.contact_auto_sms_policy
    ? { id: lead.contact_id, phone: lead.phone, display_name: lead.contact_name ?? null,
      classification: lead.contact_classification, auto_sms_policy: lead.contact_auto_sms_policy, version: lead.contact_version }
    : null;
}

export function contactLeadFields(contact: ContactDetails | null) {
  return {
    contact_id: contact?.id ?? null, contact_version: contact?.version ?? null,
    contact_name: contact?.display_name ?? null, contact_classification: contact?.classification ?? null,
    contact_auto_sms_policy: contact?.auto_sms_policy ?? null, is_personal: contact?.classification === "personal",
  };
}

export function contactEditPatch(version: number, name: string, classification: ContactClassification, policy: ContactSmsPolicy) {
  return { version, displayName: name.trim() || null, classification, autoSmsPolicy: classification === "customer" ? policy : "suppress" };
}

export function contactReplyDraft(current: string, templates: readonly string[], schedulingUrl: string | null): string {
  // Never overwrite a reply the owner is already composing.
  if (current.trim()) return current;
  const template = templates.find((value) => value.trim())?.trim() ?? "Thanks for calling. How can I help?";
  const booking = schedulingUrl ? `Book here: ${schedulingUrl}` : "";
  return booking && !template.includes(schedulingUrl!) ? `${template}\n\n${booking}` : template;
}

export const CONTACT_REMOVAL_COPY = "Removing this contact returns retained calls to the business inbox, except calls in Trash. Future missed calls follow ordinary automatic-text rules. Past skipped texts are never sent.";
export const CONTACT_ENABLE_COPY = "Only future missed calls become eligible. Account texting rules and recipient opt-outs still apply. Past skipped texts are never sent. Saving a contact does not grant texting consent.";
