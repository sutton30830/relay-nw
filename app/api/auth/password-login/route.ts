import { redirect } from "next/navigation";
import { createSupabaseAuthServerClient, resolveAccountUserSessionForUser } from "@/lib/auth";

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
  const password = String(formData.get("password") || "");
  const next = safeNext(formData.get("next"));

  if (!email || !password) {
    redirect(`/login?error=password_missing&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    console.warn("Supabase password sign-in failed", { email, error: error?.message ?? "missing user" });
    redirect(`/login?error=password&next=${encodeURIComponent(next)}`);
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
