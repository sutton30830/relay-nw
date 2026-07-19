import { redirect } from "next/navigation";
import { createSupabaseAuthServerClient, resolveAccountUserSessionForUser } from "@/lib/auth";

function safeNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/leads";
  }

  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const next = safeNext(url.searchParams.get("next"));

  if (!code && !tokenHash) {
    redirect(`/login?error=missing_code&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = tokenHash
    ? await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type === "recovery" ? "recovery" : "email",
      })
    : await supabase.auth.exchangeCodeForSession(code!);

  if (error) {
    console.warn("Supabase auth callback failed", { error: error.message });
    redirect(`/login?error=callback&next=${encodeURIComponent(next)}`);
  }

  if (!data.user) {
    console.warn("Supabase auth callback returned no user after code exchange");
    redirect(`/login?error=callback&next=${encodeURIComponent(next)}`);
  }

  // Resolve the Relay account from the freshly exchanged Supabase user instead
  // of doing a second cookie-based lookup in this same request. Some runtimes
  // only make the newly set auth cookies visible on the outgoing response; a
  // same-request cookie read can falsely look unauthenticated and strand owners
  // after a valid magic-link click.
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
