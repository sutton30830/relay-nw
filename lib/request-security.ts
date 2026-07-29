const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const PROTECTED_MUTATION_PREFIXES = [
  "/api/auth/",
  "/api/billing/",
  "/api/email-test/",
  "/api/leads/",
  "/api/leads-logout",
  "/api/ops/",
  "/api/settings",
];

function parseOrigin(value: string | null | undefined) {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isProtectedBrowserMutation(request: Request) {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  return PROTECTED_MUTATION_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

export function isTrustedBrowserMutation(
  request: Request,
  configuredAppBaseUrl?: string | null,
) {
  if (!isProtectedBrowserMutation(request)) {
    return true;
  }

  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = parseOrigin(configuredAppBaseUrl);
  const allowedOrigins = new Set(
    [requestOrigin, configuredOrigin].filter((value): value is string => Boolean(value)),
  );
  const origin = request.headers.get("origin");

  if (origin) {
    const normalizedOrigin = parseOrigin(origin);
    return Boolean(normalizedOrigin && allowedOrigins.has(normalizedOrigin));
  }

  // Browsers that omit Origin still send Fetch Metadata on form/fetch requests.
  // Fail closed if both signals are absent: these endpoints are browser-only,
  // authenticated mutation surfaces rather than provider webhooks or public APIs.
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function rejectedMutationResponse() {
  return Response.json(
    { error: "Cross-origin request blocked" },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export function requestClientIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim().toLowerCase() || "unknown";
  }

  return request.headers.get("x-real-ip")?.trim().toLowerCase() || "unknown";
}
