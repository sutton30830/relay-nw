import { createHmac } from "node:crypto";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { notifyOwnerPasswordSetup } from "@/lib/email";
import { requestClientIp } from "@/lib/request-security";
import { consumePasswordResetRateLimit, supabaseAdmin } from "@/lib/supabase";

const RESET_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RESET_RATE_LIMIT_PER_EMAIL = 5;
const RESET_RATE_LIMIT_PER_IP = 20;

function safeNext(value: FormDataEntryValue | null) {
  const next = String(value || "/account/password");
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/account/password";
  }

  return next;
}

function rateLimitHash(kind: "email" | "ip", value: string) {
  return createHmac("sha256", env.authRateLimitSalt)
    .update(`${kind}:${value}`)
    .digest("hex");
}

function finishResetRequest(intent: "forgot" | "setup"): never {
  // This location is deliberately identical for existing, unknown, limited,
  // and provider-error cases. The requester learns only that the request was
  // accepted, never whether the address belongs to a Relay account.
  redirect(`/login?reset=${intent}&next=${encodeURIComponent("/leads")}`);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const next = safeNext(formData.get("next"));
  const intent = formData.get("intent") === "forgot" ? "forgot" : "setup";

  if (!email) {
    redirect(`/login?error=email&next=${encodeURIComponent("/leads")}`);
  }

  const emailHash = rateLimitHash("email", email);
  const ipHash = rateLimitHash("ip", requestClientIp(request));

  let allowed = false;

  try {
    allowed = await consumePasswordResetRateLimit({
      emailHash,
      ipHash,
      windowSeconds: RESET_RATE_LIMIT_WINDOW_SECONDS,
      maxPerEmail: RESET_RATE_LIMIT_PER_EMAIL,
      maxPerIp: RESET_RATE_LIMIT_PER_IP,
    });
  } catch (error) {
    // Password reset is a security-sensitive email side effect. Fail closed
    // when the durable limiter cannot establish that this request is allowed.
    console.error("Password reset rate-limit check failed", {
      emailHash: emailHash.slice(0, 12),
      error: error instanceof Error ? error.message : error,
    });
    finishResetRequest(intent);
  }

  if (!allowed) {
    console.warn("Password reset rate limited", {
      emailHash: emailHash.slice(0, 12),
      ipHash: ipHash.slice(0, 12),
    });
    finishResetRequest(intent);
  }

  const escapedEmail = email.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const membership = await supabaseAdmin
    .from("account_users")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(1)
    .maybeSingle();

  if (membership.error) {
    console.warn("Password setup membership lookup failed", {
      emailHash: emailHash.slice(0, 12),
      error: membership.error.message,
    });
    finishResetRequest(intent);
  }

  if (!membership.data) {
    finishResetRequest(intent);
  }

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email,
  });

  if (error) {
    console.warn("Supabase password setup link generation failed", {
      emailHash: emailHash.slice(0, 12),
      error: error.message,
    });
    finishResetRequest(intent);
  }

  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) {
    console.warn("Supabase password setup link generation returned no token hash", {
      emailHash: emailHash.slice(0, 12),
    });
    finishResetRequest(intent);
  }

  const setupUrl = new URL("/auth/recovery", env.appBaseUrl);
  setupUrl.searchParams.set("type", "recovery");
  setupUrl.searchParams.set("token_hash", tokenHash);
  setupUrl.searchParams.set("next", next);

  const result = await notifyOwnerPasswordSetup({
    to: email,
    setupUrl: setupUrl.toString(),
    purpose: intent === "forgot" ? "reset" : "setup",
  });

  if (!result.sent) {
    console.warn("Password setup email delivery failed", {
      emailHash: emailHash.slice(0, 12),
      skipped: result.skipped,
    });
  }

  finishResetRequest(intent);
}
