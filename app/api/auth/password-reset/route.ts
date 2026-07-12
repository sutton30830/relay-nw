import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { createSupabaseAuthServerClient } from "@/lib/auth";

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

  const supabase = await createSupabaseAuthServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.appBaseUrl}/auth/callback?next=${encodeURIComponent(next)}`,
  });

  if (error) {
    console.warn("Supabase password reset email failed", { email, error: error.message });
    redirect(`/login?error=reset&next=${encodeURIComponent("/leads")}`);
  }

  redirect(`/login?reset=1&next=${encodeURIComponent("/leads")}`);
}
