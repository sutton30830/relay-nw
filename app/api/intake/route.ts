import { redirect } from "next/navigation";
import { createLead } from "@/lib/supabase";

const MAX_FIELD_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;
const BUSINESS_TYPES = new Set(["HVAC", "Plumbing", "Electrical", "Other"]);

type SetupSubmission = {
  businessName: string;
  ownerName: string;
  phoneRaw: string;
  businessType: string;
  currentBusinessNumber: string;
  preferredCallbackNumber: string;
  notes: string;
  honeypot: string;
};

/**
 * Lightweight US phone normalization to E.164 so owner callback links work.
 * Accepts punctuation. Returns null if the value isn't a plausible US number.
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

function parseSetupForm(formData: FormData): SetupSubmission {
  return {
    businessName: readFormString(formData, "businessName"),
    ownerName: readFormString(formData, "ownerName"),
    phoneRaw: readFormString(formData, "phone"),
    businessType: readFormString(formData, "businessType"),
    currentBusinessNumber: readFormString(formData, "currentBusinessNumber"),
    preferredCallbackNumber: readFormString(formData, "preferredCallbackNumber"),
    notes: readFormString(formData, "notes"),
    honeypot: readFormString(formData, "company"),
  };
}

function isBotSubmission(submission: SetupSubmission) {
  return Boolean(submission.honeypot);
}

function isTooLong(value: string, max: number) {
  return value.length > max;
}

function validateSetupSubmission(submission: SetupSubmission) {
  const ownerPhone = normalizeUsPhone(submission.phoneRaw);

  if (
    !submission.businessName ||
    !submission.ownerName ||
    !ownerPhone ||
    !submission.currentBusinessNumber ||
    !BUSINESS_TYPES.has(submission.businessType)
  ) {
    return null;
  }

  if (
    isTooLong(submission.businessName, MAX_FIELD_LENGTH) ||
    isTooLong(submission.ownerName, MAX_FIELD_LENGTH) ||
    isTooLong(submission.currentBusinessNumber, MAX_FIELD_LENGTH) ||
    isTooLong(submission.preferredCallbackNumber, MAX_FIELD_LENGTH) ||
    isTooLong(submission.notes, MAX_NOTES_LENGTH)
  ) {
    return null;
  }

  return {
    ownerPhone,
    message: [
      "Relay NW setup request",
      `Business name: ${submission.businessName}`,
      `Owner name: ${submission.ownerName}`,
      `Business type: ${submission.businessType}`,
      `Owner phone: ${submission.phoneRaw}`,
      `Current business number: ${submission.currentBusinessNumber}`,
      submission.preferredCallbackNumber
        ? `Preferred callback number: ${submission.preferredCallbackNumber}`
        : null,
      submission.notes ? `Notes: ${submission.notes}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    leadName: `${submission.businessName} - ${submission.ownerName}`,
  };
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const submission = parseSetupForm(formData);

  if (isBotSubmission(submission)) {
    redirect("/intake?saved=1");
  }

  const setupLead = validateSetupSubmission(submission);

  if (!setupLead) {
    redirect("/intake?error=1");
  }

  try {
    await createLead({
      name: setupLead.leadName,
      phone: setupLead.ownerPhone,
      message: setupLead.message,
      source: "intake_form",
    });
  } catch (error) {
    console.error("Failed to save Relay NW setup request", error);
    redirect("/intake?error=1");
  }

  redirect("/intake?saved=1");
}
