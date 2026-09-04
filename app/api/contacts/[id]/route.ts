import { requireWriteAccessJson } from "@/lib/auth";
import { deleteKnownContact, updateKnownContact } from "@/lib/supabase/contacts";
import { contactApiError, invalidateContactReads, privateAuthResponse, privateContactResponse, readContactBody } from "@/lib/contact-api";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireWriteAccessJson();
  if (auth.response) return privateAuthResponse(auth.response);
  try {
    const { id } = await params;
    const body = await readContactBody(request, ["version", "displayName", "classification", "autoSmsPolicy"]);
    const contact = await updateKnownContact(auth.session.accountId, id, body);
    invalidateContactReads();
    return privateContactResponse({ contact });
  } catch (error) { return contactApiError(error); }
}
export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireWriteAccessJson();
  if (auth.response) return privateAuthResponse(auth.response);
  try {
    const { id } = await params;
    const body = await readContactBody(request, ["version"]);
    await deleteKnownContact(auth.session.accountId, id, body.version);
    invalidateContactReads();
    return privateContactResponse({ removed: true });
  } catch (error) { return contactApiError(error); }
}
