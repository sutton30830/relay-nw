import { redirect } from "next/navigation";
import { createLead } from "@/lib/supabase";

const MAX_NAME_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 2000;

type IntakeFormSubmission = {
  name: string;
  phoneRaw: string;
  message: string;
  consent: FormDataEntryValue | null;
  honeypot: string;
};

type IntakeLeadInput = {
  name: string | null;
  phone: string;
  message: string | null;
};

/**
 * Lightweight US phone normalization to E.164 so leads page tel:/sms: links
 * always dial correctly. Accepts any punctuation the user typed.
 * Returns null if the value can't be parsed as a plausible US number.
 */
function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return null;
}

function readFormString(formData: FormData, key: string) {
  return String(formData.get(key) || "").trim();
}

function parseIntakeForm(formData: FormData): IntakeFormSubmission {
  return {
    name: readFormString(formData, "name"),
    phoneRaw: readFormString(formData, "phone"),
    message: readFormString(formData, "message"),
    consent: formData.get("consent"),
    honeypot: readFormString(formData, "company"),
  };
}

function isBotSubmission(submission: IntakeFormSubmission) {
  // Spam trap: bots tend to fill every field. Silently "succeed".
  return Boolean(submission.honeypot);
}

function validateIntakeSubmission(submission: IntakeFormSubmission): IntakeLeadInput | null {
  const phone = normalizeUsPhone(submission.phoneRaw);

  if (!phone || submission.consent !== "on") {
    return null;
  }

  if (submission.name.length > MAX_NAME_LENGTH) {
    return null;
  }

  if (submission.message.length > MAX_MESSAGE_LENGTH) {
    return null;
  }

  return {
    name: submission.name || null,
    phone,
    message: submission.message || null,
  };
}

async function saveIntakeLead(lead: IntakeLeadInput) {
  await createLead({
    ...lead,
    source: "intake_form",
  });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const submission = parseIntakeForm(formData);

  if (isBotSubmission(submission)) {
    redirect("/intake?saved=1");
  }

  const lead = validateIntakeSubmission(submission);

  if (!lead) {
    redirect("/intake?error=1");
  }

  try {
    await saveIntakeLead(lead);
  } catch (error) {
    console.error("Failed to save intake form lead", error);
    redirect("/intake?error=1");
  }

  redirect("/intake?saved=1");
}
