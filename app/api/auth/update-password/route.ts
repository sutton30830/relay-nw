import { redirect } from "next/navigation";
import { createSupabaseAuthServerClient, resolveAccountUserSessionForUser } from "@/lib/auth";

const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: Request) {
  const formData = await request.formData();
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (password.length < MIN_PASSWORD_LENGTH) {
    redirect("/account/password?error=short");
  }

  if (password !== confirmPassword) {
    redirect("/account/password?error=mismatch");
  }

  const supabase = await createSupabaseAuthServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    redirect("/login?error=session_expired&next=/account/password");
  }

  const resolution = await resolveAccountUserSessionForUser(userData.user);

  if (resolution.status === "ambiguous" || resolution.status === "invalid_selection") {
    redirect("/account/select?next=/account/password");
  }

  if (resolution.status !== "single_account" && resolution.status !== "selected_account") {
    await supabase.auth.signOut();
    redirect("/login?error=not_invited&next=/account/password");
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    console.warn("Supabase password update failed", { email: userData.user.email, error: error.message });
    redirect("/account/password?error=save_failed");
  }

  redirect("/leads?password_set=1");
}
