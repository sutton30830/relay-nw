import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { createSupabaseAuthServerClient } from "@/lib/auth";

const LOGIN_LINK_COOLDOWN_SECONDS = 75;
const LOGIN_LINK_COOKIE = "relay_login_link_requested";

function safeNext(value: FormDataEntryValue | null) {
  const next = String(value || "/leads");
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/leads";
  }

  return next;
}

function loginEmailHash(email: string) {
  return createHash("sha256").update(email).digest("hex");
}

function requestedRecently(cookieValue: string | undefined, email: string, now: number) {
  if (!cookieValue) return false;

  const [hash, timestamp] = cookieValue.split(".");
  const requestedAt = Number(timestamp);

  if (hash !== loginEmailHash(email) || !Number.isFinite(requestedAt)) {
    return false;
  }

  return now - requestedAt < LOGIN_LINK_COOLDOWN_SECONDS * 1000;
}

function isAuthRateLimit(error: { message?: string; status?: number } | null) {
  if (!error) return false;

  return error.status === 429 || /rate|too many|security purposes|after \d+ seconds/i.test(error.message ?? "");
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const next = safeNext(formData.get("next"));

  if (!email) {
    redirect(`/login?error=email&next=${encodeURIComponent(next)}`);
  }

  const cookieStore = await cookies();
  const now = Date.now();

  if (requestedRecently(cookieStore.get(LOGIN_LINK_COOKIE)?.value, email, now)) {
    redirect(`/login?sent=recent&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseAuthServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${env.appBaseUrl}/auth/callback?next=${encodeURIComponent(next)}`,
      shouldCreateUser: false,
    },
  });

  if (error) {
    console.warn("Supabase magic-link sign-in failed", { email, error: error.message });
    if (isAuthRateLimit(error)) {
      redirect(`/login?error=rate_limited&next=${encodeURIComponent(next)}`);
    }
    redirect(`/login?error=sign_in&next=${encodeURIComponent(next)}`);
  }

    cookieStore.set(LOGIN_LINK_COOKIE, `${loginEmailHash(email)}.${now}`, {
      httpOnly: true,
      maxAge: LOGIN_LINK_COOLDOWN_SECONDS,
      path: "/api/auth/login",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  redirect(`/login?sent=1&next=${encodeURIComponent(next)}`);
}
