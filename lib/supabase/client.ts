import "server-only";

import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export function isPlaceholderSupabaseConfig() {
  return (
    env.supabaseUrl.includes("example.supabase.co") ||
    env.supabaseServiceRoleKey === "test-service-role-key" ||
    env.supabaseServiceRoleKey.includes("your_service_role_key")
  );
}

export function shouldSkipDatabaseWrite(action: string, details?: unknown) {
  if (!isPlaceholderSupabaseConfig()) {
    return false;
  }

  console.warn(`Skipping ${action} because Supabase is using placeholder values.`, details);
  return true;
}

export function throwIfSupabaseError(error: { message: string } | null) {
  if (error) {
    throw error;
  }
}
