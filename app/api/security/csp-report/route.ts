export const runtime = "nodejs";

const MAX_REPORT_BYTES = 16_384;

function safeOrigin(value: unknown) {
  if (typeof value !== "string" || !value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  try {
    const report = await request.json() as Record<string, unknown>;
    const body =
      report["csp-report"] && typeof report["csp-report"] === "object"
        ? report["csp-report"] as Record<string, unknown>
        : report;

    console.warn("CSP report-only violation", {
      effectiveDirective:
        typeof body["effective-directive"] === "string"
          ? body["effective-directive"].slice(0, 100)
          : null,
      violatedDirective:
        typeof body["violated-directive"] === "string"
          ? body["violated-directive"].slice(0, 100)
          : null,
      blockedOrigin: safeOrigin(body["blocked-uri"]),
      documentOrigin: safeOrigin(body["document-uri"]),
    });
  } catch {
    // CSP reports are diagnostics, not an application dependency. Malformed
    // reports are discarded without echoing attacker-controlled content.
  }

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
