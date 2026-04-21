import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export type LeadSource = "missed_call" | "intake_form";
export type LeadStatus = "new" | "contacted" | "booked" | "dead";
export type WebhookEventSource = "twilio_voice" | "twilio_dial_status";

export type Lead = {
  id: string;
  call_sid: string | null;
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
  callSid?: string | null;
}) {
  if (isPlaceholderSupabaseConfig()) {
    console.warn("Skipping lead insert because Supabase is using placeholder local values.", input);
    return;
  }

  const { error } = await supabaseAdmin.from("leads").insert({
    call_sid: input.callSid ?? null,
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

export async function createMissedCallLeadIfNew(input: {
  callSid: string;
  phone: string;
  message: string;
}) {
  if (isPlaceholderSupabaseConfig()) {
    console.warn("Skipping missed call lead insert because Supabase is using placeholder values.", input);
    return { inserted: true, leadId: null };
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .insert({
      call_sid: input.callSid,
      phone: input.phone,
      message: input.message,
      source: "missed_call",
      status: "new",
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return { inserted: false, leadId: null };
    }

    throw error;
  }

  return {
    inserted: Boolean(data?.id),
    leadId: data?.id ?? null,
  };
}

export async function getLeads() {
  if (isPlaceholderSupabaseConfig()) {
    return [] as Lead[];
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, call_sid, name, phone, message, source, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as Lead[];
}

export async function updateLeadStatus(input: { id: string; status: LeadStatus }) {
  if (isPlaceholderSupabaseConfig()) {
    console.warn("Skipping lead status update because Supabase is using placeholder values.", input);
    return;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update({ status: input.status })
    .eq("id", input.id);

  if (error) {
    throw error;
  }
}

export async function logWebhookEvent(input: {
  source: WebhookEventSource;
  payload: Record<string, string>;
  responseStatus: number;
  responseBody?: string | null;
  error?: string | null;
}) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  const { error } = await supabaseAdmin.from("webhook_events").insert({
    source: input.source,
    payload: input.payload,
    response_status: input.responseStatus,
    response_body: input.responseBody ?? null,
    error: input.error ?? null,
  });

  if (error) {
    console.error("Failed to log webhook event", error);
  }
}
