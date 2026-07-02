import type { LeadPatch, TranscribeResponse, TranscribeResult } from "./_types";
import type { ForwardingHealthSummary } from "@/lib/forwarding-health";
import type { OutboundMessage } from "@/lib/supabase";
import { humanVoicemailError } from "./_utils";

export type SendReplyResult =
  | { ok: true; message: OutboundMessage }
  | { ok: false; error: string };

export async function sendLeadReply(id: string, body: string): Promise<SendReplyResult> {
  try {
    const response = await fetch(`/api/leads/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });

    const data = await response.json().catch(() => null) as
      | { ok: true; message: OutboundMessage }
      | { error?: string }
      | null;

    if (!response.ok || !data || !("ok" in data)) {
      return {
        ok: false,
        error: (data && "error" in data && data.error) || "Could not send the reply. Try again.",
      };
    }

    return { ok: true, message: data.message };
  } catch (error) {
    console.error("Failed to send reply from inbox", { leadId: id, error });
    return { ok: false, error: "Could not reach Relay. Check your connection and try again." };
  }
}

export type ForwardingHealthResponse = ForwardingHealthSummary & {
  healthCheckId?: string;
  error?: string;
};

export type SmsTestStatus =
  | "accepted"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered";

export type SmsTestResponse = {
  messageSid?: string;
  status?: SmsTestStatus;
  toLast4?: string | null;
  error?: string;
  detail?: string;
  errorCode?: number | null;
  errorMessage?: string | null;
  dateUpdated?: string | null;
};

export async function patchLead(id: string, body: LeadPatch) {
  try {
    const response = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("Failed to update lead from inbox", {
        leadId: id,
        status: response.status,
        body,
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Failed to update lead from inbox", { leadId: id, error });
    return false;
  }
}

export async function deleteLead(id: string) {
  try {
    const response = await fetch(`/api/leads/${id}`, {
      method: "DELETE",
    });

    return response.ok;
  } catch (error) {
    console.error("Failed to delete lead from inbox", { leadId: id, error });
    return false;
  }
}

export async function requestVoicemailSummary(id: string): Promise<TranscribeResult> {
  try {
    const response = await fetch(`/api/leads/${id}/transcribe`, {
      method: "POST",
    });

    const data = await response.json().catch(() => null) as TranscribeResponse | { error?: string } | null;

    if (!response.ok) {
      return {
        ok: false,
        error: humanVoicemailError(data && "error" in data ? data.error : null),
      };
    }

    return { ok: true, data: data as TranscribeResponse };
  } catch (error) {
    console.error("Failed to summarize voicemail from inbox", { leadId: id, error });
    return {
      ok: false,
      error: "Relay could not reach the transcription service. Try again in a minute.",
    };
  }
}

export async function fetchForwardingHealthStatus() {
  const response = await fetch("/api/health-check/status", { cache: "no-store" });
  const data = await response.json().catch(() => null) as ForwardingHealthResponse | null;

  if (!response.ok || !data) {
    throw new Error(data?.error ?? "Unable to load forwarding health status.");
  }

  return data;
}

export async function startForwardingHealthCheck() {
  const response = await fetch("/api/health-check/start", { method: "POST", cache: "no-store" });
  const data = await response.json().catch(() => null) as ForwardingHealthResponse | null;

  if (!response.ok || !data) {
    throw new Error(data?.error ?? "Unable to start forwarding health check.");
  }

  return data;
}

export async function startSmsTest() {
  const response = await fetch("/api/sms-test/start", { method: "POST", cache: "no-store" });
  const data = await response.json().catch(() => null) as SmsTestResponse | null;

  if (!response.ok || !data) {
    throw new Error(data?.error ?? "Unable to send SMS test.");
  }

  return data;
}

export async function fetchSmsTestStatus(messageSid: string) {
  const response = await fetch(`/api/sms-test/status?messageSid=${encodeURIComponent(messageSid)}`, {
    cache: "no-store",
  });
  const data = await response.json().catch(() => null) as SmsTestResponse | null;

  if (!response.ok || !data) {
    throw new Error(data?.error ?? "Unable to load SMS test status.");
  }

  return data;
}
