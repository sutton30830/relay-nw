import { env } from "@/lib/env";
import { classifyPriority, type PriorityClassification } from "@/lib/priority";
import {
  getAccountConfigByAccountId,
  getLeadForVoicemailTranscription,
  updateLeadPriority,
  updateLeadVoicemailTranscription,
} from "@/lib/supabase";
import { sendOwnerSms } from "@/lib/twilio";
import { notifyAdminOperationalIssue, notifyOwnerVoicemailReady } from "@/lib/email";

type OpenAITranscriptionResponse = {
  text?: string;
};

type OpenAIResponsesResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
};

const STALE_PROCESSING_MS = 10 * 60 * 1000;

const TRANSCRIPTION_CONTEXT =
  "This voicemail is for a local home service business. Common words include sink, faucet, toilet, drain, leak, leaking, water heater, HVAC, furnace, electrical, breaker, outlet, estimate, quote, appointment, callback, and service call.";

const TRANSCRIPT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bsync\b/gi, "sink"],
  [/\bsynced\b/gi, "sink"],
  [/\bfoss it\b/gi, "faucet"],
  [/\bfaucett\b/gi, "faucet"],
  [/\bhot water tank\b/gi, "water heater"],
];

function twilioRecordingUrl(recordingSid: string) {
  return `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Recordings/${recordingSid}.mp3`;
}

async function fetchRecordingAudio(recordingSid: string) {
  const auth = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString("base64");
  const response = await fetch(twilioRecordingUrl(recordingSid), {
    headers: {
      Authorization: `Basic ${auth}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Twilio recording download failed with ${response.status}.`);
  }

  return response.blob();
}

async function transcribeAudio(audio: Blob) {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const form = new FormData();
  form.append("file", audio, "voicemail.mp3");
  form.append("model", env.openaiTranscriptionModel);
  form.append("response_format", "json");
  form.append("prompt", TRANSCRIPTION_CONTEXT);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(await openAIError("OpenAI transcription", response));
  }

  const data = await response.json() as OpenAITranscriptionResponse;
  const transcript = data.text?.trim();

  if (!transcript) {
    throw new Error("OpenAI transcription returned no text.");
  }

  return cleanTranscript(transcript);
}

function cleanTranscript(transcript: string) {
  return TRANSCRIPT_REPLACEMENTS.reduce(
    (cleaned, [pattern, replacement]) => cleaned.replace(pattern, replacement),
    transcript,
  );
}

async function summarizeTranscript(transcript: string) {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.openaiSummaryModel,
      max_output_tokens: 120,
      input: [
        {
          role: "system",
          content:
            "Summarize a voicemail for a local service business owner. Use one short sentence. State only what the caller explicitly said. Do not infer urgency. Do not say urgent, emergency, ASAP, today, or immediate unless the caller clearly said that. If the caller only says they want help, a quote, a callback, or to check something out, describe it as a normal request. Include callback timing only if the caller mentioned one. Do not invent details.",
        },
        {
          role: "user",
          content: transcript.slice(0, 4000),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(await openAIError("OpenAI summary", response));
  }

  const data = await response.json() as OpenAIResponsesResponse;
  const summary = extractResponseText(data);

  if (!summary) {
    throw new Error("OpenAI summary returned no text.");
  }

  return summary;
}

async function clarifyTranscript(transcript: string) {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.openaiSummaryModel,
      max_output_tokens: 180,
      input: [
        {
          role: "system",
          content:
            "Clean up a voicemail transcript for a local home service business. Fix obvious transcription mistakes and home-service homophones. Preserve the caller's meaning. Do not summarize. Do not change names, pronouns, or personal identifiers. Do not add urgency, names, dates, problems, or details that are not clearly present. If a phrase is unclear, leave it plain rather than guessing.",
        },
        {
          role: "user",
          content: transcript.slice(0, 4000),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(await openAIError("OpenAI transcript cleanup", response));
  }

  const data = await response.json() as OpenAIResponsesResponse;
  const clarified = extractResponseText(data)?.trim();

  return clarified || transcript;
}

// Keyword regex first (fast, free, predictable), then an LLM pass only when the regex
// finds nothing — it catches phrasings no keyword list can ("my tenant is furious",
// "the ceiling is dripping onto the breaker box"). The LLM can only upgrade a
// "normal", never veto a regex hit, and any failure falls back to the regex result.
async function classifyVoicemailPriority(text: string): Promise<PriorityClassification> {
  const regexResult = classifyPriority(text);

  if (regexResult.level !== "normal" || !env.openaiApiKey || !text.trim()) {
    return regexResult;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.openaiSummaryModel,
        max_output_tokens: 40,
        input: [
          {
            role: "system",
            content:
              "Classify the urgency of a voicemail left for a local home services business. Reply with exactly one line in the format `level - reason`. level is one of: fast, today, normal. fast = active damage, safety risk, or the caller explicitly says it is urgent or an emergency. today = the caller wants service today or tomorrow, or the problem is clearly time-sensitive. normal = everything else, including quotes and routine requests. The reason must be 3-8 words describing only what the caller actually said. Do not invent urgency.",
          },
          {
            role: "user",
            content: text.slice(0, 4000),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(await openAIError("OpenAI urgency classification", response));
    }

    const data = await response.json() as OpenAIResponsesResponse;
    const raw = extractResponseText(data) ?? "";
    const match = raw.match(/^\s*(fast|today|normal)\s*[-–—:]?\s*(.*)$/i);

    if (!match) {
      return regexResult;
    }

    const level = match[1].toLowerCase() as PriorityClassification["level"];
    const reason = match[2]?.trim().slice(0, 120) || null;

    return { level, reason: level === "normal" ? null : reason };
  } catch (error) {
    console.warn("LLM urgency classification failed; using keyword result", {
      error: error instanceof Error ? error.message : error,
    });
    return regexResult;
  }
}

async function openAIError(label: string, response: Response) {
  const body = await response.text();
  const detail = body ? ` ${body.slice(0, 500)}` : "";

  return `${label} failed with ${response.status}.${detail}`;
}

function extractResponseText(data: OpenAIResponsesResponse) {
  const directText = data.output_text?.trim();

  if (directText) {
    return directText;
  }

  return data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .find((text) => text?.trim())
    ?.trim();
}

export async function transcribeLeadVoicemail(leadId: string, accountId: string) {
  const lead = await getLeadForVoicemailTranscription(leadId, accountId);

  if (!lead?.recording_sid) {
    throw new Error("Lead does not have a voicemail recording.");
  }

  if (lead.voicemail_transcription_status === "processing") {
    // A run that started recently is genuinely in flight. But if the process crashed
    // between marking "processing" and finishing (e.g. serverless timeout), the lead
    // would otherwise be locked in "Generating summary…" forever. Treat old
    // "processing" rows as stale and take over.
    const startedAt = lead.voicemail_transcribed_at ? Date.parse(lead.voicemail_transcribed_at) : NaN;
    const isStale = !Number.isFinite(startedAt) || Date.now() - startedAt > STALE_PROCESSING_MS;

    if (!isStale) {
      throw new Error("Voicemail summary is already generating.");
    }

    console.warn("Taking over stale voicemail transcription", {
      leadId,
      accountId,
      staleSince: lead.voicemail_transcribed_at,
    });
  }

  if (lead.voicemail_summary && lead.voicemail_transcript) {
    return {
      transcript: lead.voicemail_transcript,
      summary: lead.voicemail_summary,
      status: "completed" as const,
    };
  }

  await updateLeadVoicemailTranscription({
    accountId,
    id: leadId,
    status: "processing",
    error: null,
  });

  try {
    const audio = await fetchRecordingAudio(lead.recording_sid);
    const rawTranscript = await transcribeAudio(audio);
    const transcript = await clarifyTranscript(rawTranscript);
    const summary = await summarizeTranscript(transcript);

    await updateLeadVoicemailTranscription({
      accountId,
      id: leadId,
      transcript,
      summary,
      status: "completed",
      error: null,
    });

    // Classify urgency from what the caller actually said, persist it, and escalate
    // fast-priority voicemails to the owner by SMS immediately. Never fatal: the
    // transcription result stands even if classification or notification fails.
    const classification = await classifyVoicemailPriority(`${transcript} ${summary}`);

    try {
      await updateLeadPriority({
        accountId,
        id: leadId,
        priority: classification.level,
        priorityReason: classification.reason,
      });
    } catch (error) {
      console.error("Could not persist lead priority", {
        leadId,
        accountId,
        error: error instanceof Error ? error.message : error,
      });
    }

    const account = await getAccountConfigByAccountId(accountId);
    if (account) {
      if (classification.level === "fast") {
        await sendOwnerSms({
          account,
          context: "urgent voicemail alert",
          body: `Relay NW URGENT: voicemail from ${lead.phone} — ${classification.reason}. "${summary.slice(0, 160)}" Call back now or reply from your inbox: ${env.appBaseUrl}/leads`,
        });
      }

      await notifyOwnerVoicemailReady({
        account,
        leadId,
        callerPhone: lead.phone,
        summary,
      });
    }

    return {
      transcript,
      summary,
      status: "completed" as const,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Voicemail transcription failed.";

    // Marking the lead "failed" is what makes the UI show "Summary unavailable. Listen
    // to the voicemail." If this update itself fails, don't mask the original error;
    // the stale-processing takeover above will recover the lead on the next attempt.
    try {
      await updateLeadVoicemailTranscription({
        accountId,
        id: leadId,
        status: "failed",
        error: message,
      });
    } catch (updateError) {
      console.error("Could not mark voicemail transcription as failed; lead may show as processing until stale takeover", {
        leadId,
        accountId,
        error: updateError instanceof Error ? updateError.message : updateError,
      });
    }

    const account = await getAccountConfigByAccountId(accountId);
    await notifyAdminOperationalIssue({
      account,
      issue: "Voicemail transcription failed",
      detail: message,
    });

    throw error;
  }
}
