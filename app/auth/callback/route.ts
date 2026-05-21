import { redirect } from "next/navigation";
import { createSupabaseAuthServerClient, getAccountUserSession } from "@/lib/auth";

function safeNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/leads";
  }

  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  if (!code) {
    redirect(`/login?error=missing_code&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseAuthServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.warn("Supabase auth callback failed", { error: error.message });
    redirect(`/login?error=callback&next=${encodeURIComponent(next)}`);
  }

  const session = await getAccountUserSession();

  if (!session) {
    await supabase.auth.signOut();
    redirect(`/login?error=not_invited&next=${encodeURIComponent(next)}`);
  }

  redirect(next);
}
