import "server-only";
import { revalidatePath } from "next/cache";
import { ContactError, contactObject } from "@/lib/contacts";

export function privateContactResponse(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}
export function privateAuthResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export function contactApiError(error: unknown) {
  return privateContactResponse({ error: error instanceof ContactError ? error.message : "Contact storage is unavailable" }, error instanceof ContactError ? error.status : 503);
}
export async function readContactBody(request: Request, fields: readonly string[], maxBytes = 16 * 1024) {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new ContactError(413, "Contact request is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new ContactError(400, "Invalid request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ContactError(413, "Contact request is too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return contactObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), fields);
  } catch (error) {
    if (error instanceof ContactError) throw error;
    throw new ContactError(400, "Invalid request body");
  } finally { reader.releaseLock(); }
}
export function invalidateContactReads() {
  // A cache refresh failure must not misreport an already committed preference.
  for (const path of ["/settings", "/leads", "/reports"]) {
    try { revalidatePath(path, "layout"); }
    catch { console.error("Contact read invalidation failed", { path }); }
  }
}
