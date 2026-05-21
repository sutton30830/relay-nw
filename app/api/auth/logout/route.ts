import { redirect } from "next/navigation";
import { createSupabaseAuthServerClient } from "@/lib/auth";

export async function POST() {
  const supabase = await createSupabaseAuthServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
