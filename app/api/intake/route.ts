import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { notifyAdminNewSetupRequest } from "@/lib/email";
import {
  countRecentSetupRequests,
  countSetupRequestsSince,
  createSetupRequest,
  getDefaultAccountConfig,
} from "@/lib/supabase";

const MAX_FIELD_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const MAX_GLOBAL_SUBMISSIONS_PER_WINDOW = 30;
const SUBMISSION_WINDOW_MS = 60 * 60 * 1000;
const BUSINESS_TYPES = new Set(["HVAC", "Plumbing", "Electrical", "Other"]);

type SetupSubmission = {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
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

function submitterHash(ip: string) {
  return createHash("sha256")
    .update(`${process.env.INTAKE_RATE_LIMIT_SALT ?? "relay-nw-intake"}:${ip}`)
    .digest("hex");
}

function parseSetupForm(formData: FormData): SetupSubmission {
  return {
    businessName: readFormString(formData, "businessName"),
    ownerName: readFormString(formData, "ownerName"),
    ownerEmail: readFormString(formData, "ownerEmail").toLowerCase(),
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
    !submission.ownerEmail ||
    !/^\S+@\S+\.\S+$/.test(submission.ownerEmail) ||
    !ownerPhone ||
    !submission.currentBusinessNumber ||
    !BUSINESS_TYPES.has(submission.businessType)
  ) {
    return null;
  }

  if (
    isTooLong(submission.businessName, MAX_FIELD_LENGTH) ||
    isTooLong(submission.ownerName, MAX_FIELD_LENGTH) ||
    isTooLong(submission.ownerEmail, MAX_FIELD_LENGTH) ||
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
      `Owner email: ${submission.ownerEmail}`,
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
  const ip = requestIp(request);
  const hash = submitterHash(ip);
  const hourAgo = new Date(Date.now() - SUBMISSION_WINDOW_MS).toISOString();

  // Fail OPEN on limiter errors: a Supabase blip must not turn away a real
  // prospect; the per-IP cap is an abuse control, not a security boundary.
  let overLimit = false;
  try {
    const [perIp, global] = await Promise.all([
      countRecentSetupRequests({ submitterHash: hash, since: hourAgo }),
      countSetupRequestsSince(hourAgo),
    ]);
    overLimit = perIp >= MAX_SUBMISSIONS_PER_WINDOW || global >= MAX_GLOBAL_SUBMISSIONS_PER_WINDOW;
  } catch (error) {
    console.error("Intake rate-limit check failed; allowing submission", { error });
  }

  if (overLimit) {
    console.warn("Relay NW setup request rate limited", { ipHash: hash.slice(0, 12) });
    redirect("/intake?rate_limited=1");
  }

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
    // Setup requests are prospects for Relay NW itself. They go to their own
    // table, never into any tenant account's leads inbox.
    await createSetupRequest({
      name: setupLead.leadName,
      businessName: submission.businessName,
      ownerName: submission.ownerName,
      ownerEmail: submission.ownerEmail,
      phone: setupLead.ownerPhone,
      businessType: submission.businessType,
      publicBusinessNumber: submission.currentBusinessNumber,
      message: setupLead.message,
      submitterHash: hash,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown setup request error";

    console.error("Failed to save Relay NW setup request", { error: message });
    redirect("/intake?error=1");
  }

  // The email notification is best-effort: the request is already saved, so a
  // notification failure must not surface an error to the prospect.
  try {
    const account = await getDefaultAccountConfig();

    await notifyAdminNewSetupRequest({
      account,
      leadName: setupLead.leadName,
      ownerPhone: setupLead.ownerPhone,
      message: setupLead.message,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown notification error";
    console.error("Setup request saved, but admin notification failed", { error: message });
  }

  redirect("/intake?saved=1");
}
