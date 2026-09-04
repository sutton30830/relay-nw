import { requireAccountUserJson, requireWriteAccessJson } from "@/lib/auth";
import { createKnownContact, listKnownContacts } from "@/lib/supabase/contacts";
import { ContactError } from "@/lib/contacts";
import { contactApiError, invalidateContactReads, privateAuthResponse, privateContactResponse, readContactBody } from "@/lib/contact-api";

export async function GET(request: Request) {
  const auth = await requireAccountUserJson();
  if (auth.response) return privateAuthResponse(auth.response);
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => !["q", "classification", "limit", "offset"].includes(key))) throw new ContactError(400, "Invalid contact filters");
    return privateContactResponse(await listKnownContacts(auth.session.accountId, {
      q: query.get("q") ?? undefined,
      classification: query.get("classification") ?? undefined,
      limit: query.has("limit") ? Number(query.get("limit")) : undefined,
      offset: query.has("offset") ? Number(query.get("offset")) : undefined,
    }));
  } catch (error) { return contactApiError(error); }
}
export async function POST(request: Request) {
  const auth = await requireWriteAccessJson();
  if (auth.response) return privateAuthResponse(auth.response);
  try {
    const body = await readContactBody(request, ["phone", "displayName", "classification"]);
    const result = await createKnownContact(auth.session.accountId, body);
    invalidateContactReads();
    return privateContactResponse(result, result.created ? 201 : 200);
  } catch (error) { return contactApiError(error); }
}
