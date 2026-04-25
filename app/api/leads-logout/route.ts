import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LEADS_COOKIE_NAME } from "@/lib/leads-auth";

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(LEADS_COOKIE_NAME);
  redirect("/leads");
}
