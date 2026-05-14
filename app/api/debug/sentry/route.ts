import { cookies } from "next/headers";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const isAuthorized = isValidLeadsSessionCookie(
    cookieStore.get(LEADS_COOKIE_NAME)?.value,
  );

  if (!isAuthorized) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  throw new Error("Relay NW Sentry verification error");
}
