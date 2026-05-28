import { redirect } from "next/navigation";
import { notifyAdminNewSetupRequest, notifyAdminOperationalIssue } from "@/lib/email";
import { createLead, getDefaultAccountConfig } from "@/lib/supabase";

const MAX_FIELD_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const SUBMISSION_WINDOW_MS = 60 * 60 * 1000;
const BUSINESS_TYPES = new Set(["HVAC", "Plumbing", "Electrical", "Other"]);

const intakeSubmissions = new Map<string, { count: number; resetAt: number }>();
let lastSubmissionPruneAt = 0;

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

function requestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return request.headers.get("x-real-ip") ?? "unknown";
}

function currentSubmissionBucket(ip: string) {
  const now = Date.now();
  const existing = intakeSubmissions.get(ip);

  if (!existing || existing.resetAt <= now) {
    return { count: 0, resetAt: now + SUBMISSION_WINDOW_MS };
  }

  return existing;
}

function pruneExpiredSubmissionBuckets() {
  const now = Date.now();

  if (now - lastSubmissionPruneAt < SUBMISSION_WINDOW_MS) {
    return;
  }

  lastSubmissionPruneAt = now;

  for (const [ip, bucket] of intakeSubmissions.entries()) {
    if (bucket.resetAt <= now) {
      intakeSubmissions.delete(ip);
    }
  }
}

function isRateLimited(ip: string) {
  return currentSubmissionBucket(ip).count >= MAX_SUBMISSIONS_PER_WINDOW;
}

function recordSubmissionAttempt(ip: string) {
  const bucket = currentSubmissionBucket(ip);
  intakeSubmissions.set(ip, {
    count: bucket.count + 1,
    resetAt: bucket.resetAt,
  });
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
  pruneExpiredSubmissionBuckets();

  const ip = requestIp(request);

  if (isRateLimited(ip)) {
    console.warn("Relay NW setup request rate limited", { ip });
    redirect("/intake?rate_limited=1");
  }

  recordSubmissionAttempt(ip);

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
    const account = await getDefaultAccountConfig();

    if (!account.accountId) {
      const message = "Default Relay NW account is not provisioned. Cannot save setup request.";
      console.error(message);
      await notifyAdminOperationalIssue({
        account,
        issue: "Intake setup request missing default account",
        detail: setupLead.message,
      });
      redirect("/intake?error=1");
    }

    await createLead({
      accountId: account.accountId,
      name: setupLead.leadName,
      phone: setupLead.ownerPhone,
      message: setupLead.message,
      source: "intake_form",
    });

    await notifyAdminNewSetupRequest({
      account,
      leadName: setupLead.leadName,
      ownerPhone: setupLead.ownerPhone,
      message: setupLead.message,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown setup request error";

    console.error("Failed to save Relay NW setup request", { error: message });
    redirect("/intake?error=1");
  }

  redirect("/intake?saved=1");
}
