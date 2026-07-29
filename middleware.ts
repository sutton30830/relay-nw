import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  isTrustedBrowserMutation,
  rejectedMutationResponse,
} from "@/lib/request-security";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function middleware(request: NextRequest) {
  if (!isTrustedBrowserMutation(request, process.env.APP_BASE_URL)) {
    return rejectedMutationResponse();
  }

  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.SUPABASE_URL ?? requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          response = NextResponse.next({
            request,
          });

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    "/leads/:path*",
    "/account/:path*",
    "/setup/:path*",
    "/ops/:path*",
    "/login",
    "/auth/:path*",
    "/api/auth/:path*",
    "/api/billing/:path*",
    "/api/leads/:path*",
    "/api/leads-logout",
    "/api/ops/:path*",
    "/api/recordings/:path*",
    "/api/email-test/:path*",
    "/api/settings/:path*",
  ],
};
