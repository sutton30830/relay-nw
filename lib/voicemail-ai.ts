import { env } from "@/lib/env";
import {
  getLeadForVoicemailTranscription,
  updateLeadVoicemailTranscription,
} from "@/lib/supabase";

type OpenAITranscriptionResponse = {
  text?: string;
};

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
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
    throw new Error(`OpenAI transcription failed with ${response.status}.`);
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

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.openaiSummaryModel,
      temperature: 0.2,
      max_tokens: 80,
      messages: [
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
    throw new Error(`OpenAI summary failed with ${response.status}.`);
  }

  const data = await response.json() as OpenAIChatResponse;
  const summary = data.choices?.[0]?.message?.content?.trim();

  if (!summary) {
    throw new Error("OpenAI summary returned no text.");
  }

  return summary;
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
