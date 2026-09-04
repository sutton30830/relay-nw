import type { LeadPatch, TranscribeResponse, TranscribeResult } from "./_types";
import type { OutboundMessage } from "@/lib/supabase";
import { humanVoicemailError } from "./_utils";

export type SendReplyResult =
  | { ok: true; message: OutboundMessage }
  | { ok: false; error: string };

export async function sendLeadReply(id: string, body: string): Promise<SendReplyResult> {
  try {
    const idempotencyKey = crypto.randomUUID();
    const response = await fetch(`/api/leads/${id}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
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

export type DisputeResult = { ok: true } | { ok: false; error: string };

// "This transcript is wrong": hides the transcript and summary for this lead
// and keeps the recording. Idempotent on the server, so a double tap is safe.
export async function disputeVoicemailTranscript(id: string): Promise<DisputeResult> {
  try {
    const response = await fetch(`/api/leads/${id}/voicemail-dispute`, { method: "POST" });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;

    if (!response.ok || !data?.ok) {
      return { ok: false, error: data?.error || "Could not hide this transcript. Try again." };
    }

    return { ok: true };
  } catch (error) {
    console.error("Failed to dispute voicemail transcript", { leadId: id, error });
    return { ok: false, error: "Could not reach Relay. Check your connection and try again." };
  }
}
