import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createLeadsSessionCookie,
  LEADS_COOKIE_NAME,
  passwordsMatch,
} from "@/lib/leads-auth";

const MAX_FAILED_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

const failedLoginAttempts = new Map<string, { count: number; resetAt: number }>();

function requestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return request.headers.get("x-real-ip") ?? "unknown";
}

function currentAttemptBucket(ip: string) {
  const now = Date.now();
  const existing = failedLoginAttempts.get(ip);

  if (!existing || existing.resetAt <= now) {
    return { count: 0, resetAt: now + WINDOW_MS };
  }

  return existing;
}

function isRateLimited(ip: string) {
  return currentAttemptBucket(ip).count >= MAX_FAILED_ATTEMPTS;
}

function recordFailedLogin(ip: string) {
  const bucket = currentAttemptBucket(ip);
  failedLoginAttempts.set(ip, {
    count: bucket.count + 1,
    resetAt: bucket.resetAt,
  });
}

function clearFailedLogins(ip: string) {
  failedLoginAttempts.delete(ip);
}

export async function POST(request: Request) {
  const ip = requestIp(request);

  if (isRateLimited(ip)) {
    console.warn("Lead inbox login rate limited", { ip });
    redirect("/leads");
  }

  const formData = await request.formData();
  const password = String(formData.get("password") || "");

  if (passwordsMatch(password)) {
    clearFailedLogins(ip);

    const cookieStore = await cookies();
    cookieStore.set(LEADS_COOKIE_NAME, createLeadsSessionCookie(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 8,
    });
  } else {
    recordFailedLogin(ip);
  }

  redirect("/leads");
}
