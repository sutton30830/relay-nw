import { requireWriteAccessJson } from "@/lib/auth";
import { contactApiError, invalidateContactReads, privateAuthResponse, privateContactResponse, readContactBody } from "@/lib/contact-api";
import { ContactError, contactName, contactObject, parseContactPhone } from "@/lib/contacts";
import { getKnownContactsByPhones, mergeKnownContacts } from "@/lib/supabase/contacts";

export async function POST(request: Request) {
  const auth = await requireWriteAccessJson();
  if (auth.response) return privateAuthResponse(auth.response);
  try {
    const body = await readContactBody(request, ["mode", "source", "country", "entries"], 256 * 1024);
    if (!["preview", "import"].includes(String(body.mode)) || !["csv", "vcard"].includes(String(body.source)) || typeof body.country !== "string" || !Array.isArray(body.entries) || !body.entries.length || body.entries.length > 250) throw new ContactError(400, "Submit 1 to 250 entries with a supported format and country");
    const valid: { phone: string; displayName: string | null; classification: "personal" | "unclassified" }[] = [];
    const rejected: { index: number; error: string }[] = [];
    for (const [index, raw] of body.entries.entries()) {
      try {
        const item = contactObject(raw, ["phone", "displayName", "classification"]);
        if (item.classification !== undefined && item.classification !== "personal" && item.classification !== "unclassified") throw new ContactError(400, "Imports cannot enable automatic texts or set Customer classification");
        valid.push({ phone: parseContactPhone(item.phone, body.country), displayName: contactName(item.displayName), classification: item.classification === "personal" ? "personal" : "unclassified" });
      } catch (error) { rejected.push({ index, error: error instanceof ContactError ? error.message : "Invalid contact" }); }
    }
    if (body.mode === "preview") {
      const existing = valid.length ? await getKnownContactsByPhones(auth.session.accountId, valid.map((e) => e.phone)) : new Map();
      return privateContactResponse({ existing: Object.fromEntries(existing), rejected });
    }
    const results = valid.length ? await mergeKnownContacts(auth.session.accountId, valid, { source: body.source as "csv" | "vcard", country: body.country }) : [];
    if (results.length) invalidateContactReads();
    return privateContactResponse({ outcomes: results.map((r) => ({ phone: r.contact.phone, action: r.created ? "added" : "existing" })), added: results.filter((r) => r.created).length, existing: results.filter((r) => !r.created).length, rejected, duplicates: valid.length - results.length });
  } catch (error) { return contactApiError(error); }
}
