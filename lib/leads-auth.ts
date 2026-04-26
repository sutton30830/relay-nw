import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

export const LEADS_COOKIE_NAME = "relay_leads_session";
const LEADS_SESSION_VALUE = "ok";

function signCookieValue(value: string) {
  return createHmac("sha256", env.leadsCookieSecret).update(value).digest("hex");
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function passwordsMatch(candidate: string) {
  return constantTimeEqual(
    signCookieValue(candidate),
    signCookieValue(env.leadsPassword),
  );
}

export function createLeadsSessionCookie() {
  return `${LEADS_SESSION_VALUE}.${signCookieValue(LEADS_SESSION_VALUE)}`;
}

export function isValidLeadsSessionCookie(cookieValue?: string) {
  if (!cookieValue) {
    return false;
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [value, signature] = parts;
  if (!value || !signature) {
    return false;
  }

  return constantTimeEqual(signature, signCookieValue(value));
}
