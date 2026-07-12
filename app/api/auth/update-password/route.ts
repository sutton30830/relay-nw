import { redirect } from "next/navigation";
import { createSupabaseAuthServerClient, getAccountUserSessionForUser } from "@/lib/auth";

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

  const session = await getAccountUserSessionForUser(userData.user);

  if (!session) {
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
