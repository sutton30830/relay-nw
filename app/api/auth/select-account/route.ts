import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  clearSelectedAccountCookie,
  createSupabaseAuthServerClient,
  resolveAccountUserSessionForUser,
  setSelectedAccountCookie,
} from "@/lib/auth";

function safeNext(value: FormDataEntryValue | null) {
  const next = String(value || "/leads");
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/leads";
  }

  return next;
}

function selectHref(error: string, next: string) {
  return `/account/select?error=${encodeURIComponent(error)}&next=${encodeURIComponent(next)}`;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const accountId = String(formData.get("accountId") || "").trim();
  const next = safeNext(formData.get("next"));
  const cookieStore = await cookies();

  if (!accountId) {
    redirect(selectHref("missing", next));
  }

  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect(`/login?next=${encodeURIComponent(`/account/select?next=${encodeURIComponent(next)}`)}`);
  }

  const resolution = await resolveAccountUserSessionForUser(data.user, accountId);

  if (resolution.status === "selected_account" || resolution.status === "single_account") {
    setSelectedAccountCookie(cookieStore, resolution.session.accountId);
    redirect(next);
  }

  if (resolution.status === "invalid_selection") {
    clearSelectedAccountCookie(cookieStore);
    redirect(selectHref("invalid", next));
  }

  if (resolution.status === "no_membership") {
    clearSelectedAccountCookie(cookieStore);
    await supabase.auth.signOut();
    redirect(`/login?error=not_invited&next=${encodeURIComponent(next)}`);
  }

  redirect(selectHref("invalid", next));
}
