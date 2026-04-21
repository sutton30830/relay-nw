import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export type LeadSource = "missed_call" | "intake_form";
export type LeadStatus = "new";

export type Lead = {
  id: string;
  name: string | null;
  phone: string;
  message: string | null;
  source: LeadSource;
  status: LeadStatus;
  created_at: string;
};

export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function isPlaceholderSupabaseConfig() {
  return (
    env.supabaseUrl.includes("example.supabase.co") ||
    env.supabaseServiceRoleKey === "test-service-role-key" ||
    env.supabaseServiceRoleKey.includes("your_service_role_key")
  );
}

export async function createLead(input: {
  name?: string | null;
  phone: string;
  message?: string | null;
  source: LeadSource;
}) {
  if (isPlaceholderSupabaseConfig()) {
    console.warn("Skipping lead insert because Supabase is using placeholder local values.", input);
    return;
  }

  const { error } = await supabaseAdmin.from("leads").insert({
    name: input.name ?? null,
    phone: input.phone,
    message: input.message ?? null,
    source: input.source,
    status: "new",
  });

  if (error) {
    throw error;
  }
}

export async function getLeads() {
  if (isPlaceholderSupabaseConfig()) {
    return [] as Lead[];
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, name, phone, message, source, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as Lead[];
}
