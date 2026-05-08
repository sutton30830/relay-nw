import { env } from "@/lib/env";
import {
  getLeadForVoicemailTranscription,
  updateLeadVoicemailTranscription,
} from "@/lib/supabase";

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

  return transcript;
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
            "Summarize a voicemail for a local service business owner. Use one concise sentence. Include the problem, urgency, and callback preference if mentioned. Do not invent details.",
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

export async function transcribeLeadVoicemail(leadId: string) {
  const lead = await getLeadForVoicemailTranscription(leadId);

  if (!lead?.recording_sid) {
    throw new Error("Lead does not have a voicemail recording.");
  }

  await updateLeadVoicemailTranscription({
    id: leadId,
    status: "processing",
    error: null,
  });

  try {
    const audio = await fetchRecordingAudio(lead.recording_sid);
    const transcript = await transcribeAudio(audio);
    const summary = await summarizeTranscript(transcript);

    await updateLeadVoicemailTranscription({
      id: leadId,
      transcript,
      summary,
      status: "completed",
      error: null,
    });

    return {
      transcript,
      summary,
      status: "completed" as const,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Voicemail transcription failed.";

    await updateLeadVoicemailTranscription({
      id: leadId,
      status: "failed",
      error: message,
    });

    throw error;
  }
}
