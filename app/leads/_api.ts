import type { LeadPatch, TranscribeResponse, TranscribeResult } from "./_types";
import type { ForwardingHealthSummary } from "@/lib/forwarding-health";
import { humanVoicemailError } from "./_utils";

export type ForwardingHealthResponse = ForwardingHealthSummary & {
  healthCheckId?: string;
  error?: string;
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
