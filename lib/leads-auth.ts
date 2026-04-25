import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

export const LEADS_COOKIE_NAME = "relay_leads_session";

function sign(value: string) {
  return createHmac("sha256", env.leadsCookieSecret).update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function passwordsMatch(candidate: string) {
  return safeEqual(sign(candidate), sign(env.leadsPassword));
}

export function createLeadsSessionCookie() {
  const value = "ok";
  return `${value}.${sign(value)}`;
}

export function isValidLeadsSessionCookie(cookieValue?: string) {
  if (!cookieValue) {
    return false;
  }

  const [value, signature] = cookieValue.split(".");
  if (!value || !signature) {
    return false;
  }

  return safeEqual(signature, sign(value));
}
