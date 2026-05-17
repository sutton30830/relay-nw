import { cookies } from "next/headers";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";

export async function isAuthorizedHealthCheckRequest() {
  const cookieStore = await cookies();
  return isValidLeadsSessionCookie(cookieStore.get(LEADS_COOKIE_NAME)?.value);
}
