import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { notifyOwnerPasswordSetup } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase";

function safeNext(value: FormDataEntryValue | null) {
  const next = String(value || "/account/password");
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/account/password";
  }

  return next;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const next = safeNext(formData.get("next"));

  if (!email) {
    redirect(`/login?error=email&next=${encodeURIComponent("/leads")}`);
  }

  const escapedEmail = email.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const membership = await supabaseAdmin
    .from("account_users")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(1)
    .maybeSingle();

  if (membership.error) {
    console.warn("Password setup membership lookup failed", { email, error: membership.error.message });
    redirect(`/login?error=reset&next=${encodeURIComponent("/leads")}`);
  }

  if (!membership.data) {
    redirect(`/login?error=not_invited&next=${encodeURIComponent("/leads")}`);
  }

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email,
  });

  if (error) {
    console.warn("Supabase password setup link generation failed", { email, error: error.message });
    redirect(`/login?error=reset&next=${encodeURIComponent("/leads")}`);
  }

  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) {
    console.warn("Supabase password setup link generation returned no token hash", { email });
    redirect(`/login?error=reset&next=${encodeURIComponent("/leads")}`);
  }

  const setupUrl = new URL("/auth/callback", env.appBaseUrl);
  setupUrl.searchParams.set("type", "recovery");
  setupUrl.searchParams.set("token_hash", tokenHash);
  setupUrl.searchParams.set("next", next);

  const result = await notifyOwnerPasswordSetup({
    to: email,
    setupUrl: setupUrl.toString(),
  });

  if (!result.sent) {
    console.warn("Password setup email delivery failed", {
      email,
      skipped: result.skipped,
    });
    redirect(`/login?error=reset&next=${encodeURIComponent("/leads")}`);
  }

  redirect(`/login?reset=1&next=${encodeURIComponent("/leads")}`);
}
