import { requireWriteAccessJson } from "@/lib/auth";
import { setLeadContactPreference } from "@/lib/supabase/contacts";
import { contactApiError, invalidateContactReads, privateAuthResponse, privateContactResponse, readContactBody } from "@/lib/contact-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWriteAccessJson();
  if (auth.response) return privateAuthResponse(auth.response);
  try {
    const { id } = await params;
    const body = await readContactBody(request, ["action", "version", "contactId"]);
    const contact = await setLeadContactPreference(auth.session.accountId, id, body);
    invalidateContactReads();
    return privateContactResponse({ contact });
  } catch (error) { return contactApiError(error); }
}
