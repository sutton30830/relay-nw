import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clearSelectedAccountCookie, createSupabaseAuthServerClient } from "@/lib/auth";

export async function POST() {
  const supabase = await createSupabaseAuthServerClient();
  await supabase.auth.signOut();
  clearSelectedAccountCookie(await cookies());
  redirect("/login");
}
