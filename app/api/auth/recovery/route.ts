import { redirect } from "next/navigation";
import { createSupabaseAuthServerClient, resolveAccountUserSessionForUser } from "@/lib/auth";

function safeNext(value: FormDataEntryValue | null) {
  const next = String(value || "/account/password");
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/account/password";
  }

  return next;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const tokenHash = String(formData.get("token_hash") || "").trim();
  const type = String(formData.get("type") || "").trim();
  const next = safeNext(formData.get("next"));

  if (!tokenHash || type !== "recovery") {
    redirect(`/login?error=missing_code&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: "recovery",
  });

  if (error) {
    console.warn("Supabase recovery token verification failed", { error: error.message });
    redirect(`/login?error=callback&next=${encodeURIComponent(next)}`);
  }

  if (!data.user) {
    console.warn("Supabase recovery token verification returned no user");
    redirect(`/login?error=callback&next=${encodeURIComponent(next)}`);
  }

  const resolution = await resolveAccountUserSessionForUser(data.user);

  if (resolution.status === "ambiguous" || resolution.status === "invalid_selection") {
    redirect(`/account/select?next=${encodeURIComponent(next)}`);
  }

  if (resolution.status !== "single_account" && resolution.status !== "selected_account") {
    await supabase.auth.signOut();
    redirect(`/login?error=not_invited&next=${encodeURIComponent(next)}`);
  }

  redirect(next);
}
