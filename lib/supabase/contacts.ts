import "server-only";
import { supabaseAdmin, isPlaceholderSupabaseConfig } from "./client";
import { assertAccountId } from "./tenant";
import { ContactError, contactClassification, contactId, contactName, contactObject, contactSmsPolicy, contactVersion, knownContactPhoneKey, parseContactPhone } from "@/lib/contacts";
import type { ContactSource, KnownContact, KnownContactMergeResult } from "./types";

function account(value: string) {
  const id = contactId(assertAccountId(value, "known contacts"));
  if (isPlaceholderSupabaseConfig()) throw new ContactError(503, "Contact storage is unavailable");
  return id;
}
function storageError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "P0002") throw new ContactError(404, "Contact or lead not found");
  if (["40001", "40P01", "23505"].includes(error.code ?? "")) throw new ContactError(409, "Contact changed; reload and try again");
  if (["22023", "23514", "23502", "22P02"].includes(error.code ?? "")) throw new ContactError(400, "Invalid contact details or automatic text policy");
  throw new ContactError(503, "Contact storage is unavailable");
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  try {
    const { data, error } = await supabaseAdmin.rpc(name, args);
    storageError(error);
    if (data === null || data === undefined) throw new ContactError(503, "Contact storage is unavailable");
    return data as T;
  } catch (error) {
    if (error instanceof ContactError) throw error;
    throw new ContactError(503, "Contact storage is unavailable");
  }
}
export async function listKnownContacts(accountId: string, input: { q?: unknown; classification?: unknown; limit?: unknown; offset?: unknown } = {}) {
  const scoped = account(accountId);
  const q = input.q ?? "";
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (typeof q !== "string" || q.length > 120 || /\u0000/.test(q) ||
    typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) throw new ContactError(400, "Invalid contact filters");
  const classification = input.classification === undefined ? null : contactClassification(input.classification);
  return rpc<{ contacts: KnownContact[]; total: number; limit: number; offset: number }>("list_known_contacts", {
    p_account_id: scoped, p_query: q.trim(), p_classification: classification, p_limit: limit, p_offset: offset,
  });
}
export async function getKnownContactsByPhones(accountId: string, phones: readonly string[]): Promise<Map<string, KnownContact>> {
  const scoped = account(accountId);
  const keys = [...new Set(phones.map(knownContactPhoneKey).filter((phone): phone is string => phone !== null))];
  const result = new Map<string, KnownContact>();
  try {
    for (let i = 0; i < keys.length; i += 250) {
      const { data, error } = await supabaseAdmin.from("account_known_contacts").select("*").eq("account_id", scoped).in("phone", keys.slice(i, i + 250));
      storageError(error);
      if (!data) throw new ContactError(503, "Contact storage is unavailable");
      for (const contact of data as KnownContact[]) result.set(contact.phone, contact);
    }
  } catch (error) {
    if (error instanceof ContactError) throw error;
    throw new ContactError(503, "Contact storage is unavailable");
  }
  return result;
}
export async function getKnownContactByPhone(accountId: string, phone: string): Promise<KnownContact | null> {
  const contacts = await getKnownContactsByPhones(accountId, [phone]);
  return contacts.get(knownContactPhoneKey(phone) ?? "") ?? null;
}

export async function mergeKnownContacts(accountId: string, entries: readonly unknown[], options: { source: ContactSource; country?: string }): Promise<KnownContactMergeResult[]> {
  const scoped = account(accountId);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 250) throw new ContactError(400, "Submit 1 to 250 contacts per batch");
  if (!["manual", "lead", "csv", "vcard", "phone_picker"].includes(options.source)) throw new ContactError(400, "Invalid contact source");
  const unique = new Map<string, { phone: string; display_name: string | null; classification: ReturnType<typeof contactClassification>; source: ContactSource }>();
  for (const entry of entries) {
    const item = contactObject(entry, ["phone", "displayName", "classification"]);
    const phone = parseContactPhone(item.phone, options.country);
    const displayName = contactName(item.displayName);
    const classification = contactClassification(item.classification);
    const previous = unique.get(phone);
    if (!previous) unique.set(phone, { phone, display_name: displayName, classification, source: options.source });
    else {
      if (previous.classification !== classification) throw new ContactError(400, "Resolve duplicate contact classifications before importing");
      if (!previous.display_name && displayName) previous.display_name = displayName;
    }
  }
  return rpc<KnownContactMergeResult[]>("merge_known_contacts", { p_account_id: scoped, p_entries: [...unique.values()] });
}
export async function createKnownContact(accountId: string, input: unknown): Promise<KnownContactMergeResult> {
  return (await mergeKnownContacts(accountId, [input], { source: "manual" }))[0];
}
export async function updateKnownContact(accountId: string, id: string, input: unknown): Promise<KnownContact> {
  const scoped = account(accountId);
  const item = contactObject(input, ["version", "displayName", "classification", "autoSmsPolicy"]);
  const patch: Record<string, unknown> = {};
  if ("displayName" in item) patch.display_name = contactName(item.displayName);
  if ("classification" in item) patch.classification = contactClassification(item.classification);
  if ("autoSmsPolicy" in item) patch.auto_sms_policy = contactSmsPolicy(item.autoSmsPolicy);
  if (!Object.keys(patch).length) throw new ContactError(400, "Nothing to update");
  return rpc<KnownContact>("update_known_contact", { p_account_id: scoped, p_id: contactId(id), p_version: contactVersion(item.version), p_patch: patch });
}
export async function deleteKnownContact(accountId: string, id: string, version: unknown): Promise<void> {
  await rpc<boolean>("delete_known_contact", { p_account_id: account(accountId), p_id: contactId(id), p_version: contactVersion(version) });
}
export async function setLeadContactPreference(accountId: string, leadId: string, input: unknown): Promise<KnownContact> {
  const scoped = account(accountId);
  const id = contactId(leadId);
  const item = contactObject(input, ["action", "version", "contactId"]);
  if (item.action !== "suppress_auto_sms" && item.action !== "mark_personal") throw new ContactError(400, "Invalid contact action");
  const version = item.version === undefined || item.version === null ? null : contactVersion(item.version);
  const expectedId = item.contactId === undefined || item.contactId === null ? null : contactId(item.contactId);
  if ((version === null) !== (expectedId === null)) throw new ContactError(400, "Supply both the current contact ID and version");
  const { data, error } = await supabaseAdmin.from("leads").select("phone").eq("account_id", scoped).eq("id", id).maybeSingle();
  storageError(error);
  if (!data) throw new ContactError(404, "Lead not found");
  return rpc<KnownContact>("set_lead_contact_preference", { p_account_id: scoped, p_lead_id: id, p_phone: parseContactPhone(data.phone), p_action: item.action, p_version: version, p_contact_id: expectedId });
}
