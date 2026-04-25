import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createLeadsSessionCookie,
  LEADS_COOKIE_NAME,
  passwordsMatch,
} from "@/lib/leads-auth";

export async function POST(request: Request) {
  const formData = await request.formData();
  const password = String(formData.get("password") || "");

  if (passwordsMatch(password)) {
    const cookieStore = await cookies();
    cookieStore.set(LEADS_COOKIE_NAME, createLeadsSessionCookie(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 8,
    });
  }

  redirect("/leads");
}
