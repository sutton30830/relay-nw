import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { createSupabaseAuthServerClient } from "@/lib/auth";

function safeNext(value: FormDataEntryValue | null) {
  const next = String(value || "/leads");
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/leads";
  }

  return next;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const next = safeNext(formData.get("next"));

  if (!email) {
    redirect(`/login?error=email&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseAuthServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${env.appBaseUrl}/auth/callback?next=${encodeURIComponent(next)}`,
      shouldCreateUser: false,
    },
  });

  if (error) {
    console.warn("Supabase magic-link sign-in failed", { email, error: error.message });
    redirect(`/login?error=sign_in&next=${encodeURIComponent(next)}`);
  }

  redirect(`/login?sent=1&next=${encodeURIComponent(next)}`);
}
