import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Missing test mock for ${specifier} while loading ${path}`);
  };

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const requestSecurity = await loadTsModule("lib/request-security.ts");
const securityHeaders = await loadTsModule("lib/security-headers.ts");
const authRateLimitMigration = await readFile(
  new URL("../docs/migrations/2026-07-29-auth-rate-limits.sql", import.meta.url),
  "utf8",
);

test("authenticated browser mutations require same-origin evidence", () => {
  const sameOrigin = new Request("https://www.relay-nw.com/api/settings", {
    method: "POST",
    headers: { origin: "https://www.relay-nw.com" },
  });
  const configuredProductionOrigin = new Request("https://relay-build.vercel.app/api/settings", {
    method: "POST",
    headers: { origin: "https://www.relay-nw.com" },
  });
  const fetchMetadataFallback = new Request("https://www.relay-nw.com/api/leads/lead-1", {
    method: "PATCH",
    headers: { "sec-fetch-site": "same-origin" },
  });
  const foreign = new Request("https://www.relay-nw.com/api/ops/team", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  const missingEvidence = new Request("https://www.relay-nw.com/api/billing/portal", {
    method: "POST",
  });
  const legacyLogout = new Request("https://www.relay-nw.com/api/leads-logout", {
    method: "POST",
  });

  assert.equal(requestSecurity.isTrustedBrowserMutation(sameOrigin), true);
  assert.equal(
    requestSecurity.isTrustedBrowserMutation(
      configuredProductionOrigin,
      "https://www.relay-nw.com",
    ),
    true,
  );
  assert.equal(requestSecurity.isTrustedBrowserMutation(fetchMetadataFallback), true);
  assert.equal(requestSecurity.isTrustedBrowserMutation(foreign), false);
  assert.equal(requestSecurity.isTrustedBrowserMutation(missingEvidence), false);
  assert.equal(requestSecurity.isTrustedBrowserMutation(legacyLogout), false);
});

test("provider webhooks and safe reads stay outside the browser mutation gate", () => {
  const twilio = new Request("https://www.relay-nw.com/api/twilio/sms", { method: "POST" });
  const stripe = new Request("https://www.relay-nw.com/api/stripe/webhook", { method: "POST" });
  const read = new Request("https://www.relay-nw.com/api/leads/lead-1", { method: "GET" });

  assert.equal(requestSecurity.isTrustedBrowserMutation(twilio), true);
  assert.equal(requestSecurity.isTrustedBrowserMutation(stripe), true);
  assert.equal(requestSecurity.isTrustedBrowserMutation(read), true);
});

test("browser security headers enforce framing and report CSP violations", () => {
  const headers = new Map(securityHeaders.SECURITY_HEADERS.map(({ key, value }) => [key, value]));

  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.match(headers.get("Permissions-Policy"), /camera=\(\)/);
  assert.match(headers.get("Content-Security-Policy-Report-Only"), /frame-ancestors 'none'/);
  assert.match(headers.get("Content-Security-Policy-Report-Only"), /report-uri \/api\/security\/csp-report/);
});

test("password-reset limiter is database-backed, atomic, and service-role-only", () => {
  assert.match(authRateLimitMigration, /create table if not exists public\.auth_rate_limit_events/);
  assert.match(authRateLimitMigration, /create or replace function public\.consume_auth_rate_limit/);
  assert.match(authRateLimitMigration, /pg_advisory_xact_lock/);
  assert.match(authRateLimitMigration, /alter table public\.auth_rate_limit_events enable row level security/);
  assert.match(authRateLimitMigration, /as restrictive for all to anon, authenticated/);
  assert.match(authRateLimitMigration, /grant execute[\s\S]*to service_role/);
  assert.doesNotMatch(authRateLimitMigration, /grant execute[\s\S]*to authenticated/);
});

test("service-role credentials are behind server-only module boundaries", async () => {
  for (const path of [
    "lib/env.ts",
    "lib/supabase/client.ts",
    "lib/supabase/index.ts",
  ]) {
    const contents = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(contents, /^import "server-only";/);
  }

  const root = new URL("../", import.meta.url);
  for await (const relativePath of glob(["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"], {
    cwd: root,
  })) {
    const contents = await readFile(new URL(relativePath, root), "utf8");
    if (!/^\s*["']use client["'];/m.test(contents)) continue;
    const parsed = ts.createSourceFile(
      relativePath,
      contents,
      ts.ScriptTarget.ES2020,
      true,
      relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (
        typeof specifier !== "string" ||
        !/^@\/lib\/(?:env|supabase(?:\/.*)?)$/.test(specifier)
      ) continue;
      const clause = statement.importClause;
      const namedImports = clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements
        : [];
      const isTypeOnly =
        clause?.isTypeOnly === true ||
        (namedImports.length > 0 && namedImports.every((item) => item.isTypeOnly));
      assert.equal(
        isTypeOnly,
        true,
        `${relativePath} must not value-import server credentials or the service-role Supabase client`,
      );
    }
  }

  const envSource = await readFile(new URL("../lib/env.ts", import.meta.url), "utf8");
  assert.doesNotMatch(envSource, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/);
});

function resetRouteMocks({
  membership = { id: "membership-1" },
  membershipError = null,
  rateLimitResult = true,
  rateLimitError = null,
  linkError = null,
  tokenHash = "token-hash",
  emailSent = true,
} = {}) {
  const calls = {
    limiter: [],
    generated: 0,
    emailed: 0,
  };
  const builder = {
    select: () => builder,
    ilike: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: membership, error: membershipError }),
  };

  return {
    calls,
    mocks: {
      "node:crypto": { createHmac },
      "next/navigation": {
        redirect: (url) => {
          throw new Error(`redirect:${url}`);
        },
      },
      "@/lib/env": {
        env: {
          appBaseUrl: "https://www.relay-nw.com",
          authRateLimitSalt: "test-rate-limit-secret",
        },
      },
      "@/lib/email": {
        notifyOwnerPasswordSetup: async () => {
          calls.emailed += 1;
          return { sent: emailSent, skipped: !emailSent };
        },
      },
      "@/lib/request-security": requestSecurity,
      "@/lib/supabase": {
        consumePasswordResetRateLimit: async (input) => {
          calls.limiter.push(input);
          if (rateLimitError) throw rateLimitError;
          return rateLimitResult;
        },
        supabaseAdmin: {
          from: () => builder,
          auth: {
            admin: {
              generateLink: async () => {
                calls.generated += 1;
                return {
                  data: { properties: { hashed_token: tokenHash } },
                  error: linkError,
                };
              },
            },
          },
        },
      },
    },
  };
}

function resetRequest(email = " Owner@Example.COM ") {
  const form = new FormData();
  form.set("email", email);
  form.set("intent", "forgot");
  form.set("next", "/account/password");
  return new Request("https://www.relay-nw.com/api/auth/password-reset", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.9" },
    body: form,
  });
}

const GENERIC_RESET_REDIRECT = /redirect:\/login\?reset=forgot&next=%2Fleads/;

test("password reset returns the same response for existing and unknown accounts", async () => {
  const existing = resetRouteMocks();
  const existingRoute = await loadTsModule(
    "app/api/auth/password-reset/route.ts",
    existing.mocks,
  );
  await assert.rejects(() => existingRoute.POST(resetRequest()), GENERIC_RESET_REDIRECT);

  const unknown = resetRouteMocks({ membership: null });
  const unknownRoute = await loadTsModule(
    "app/api/auth/password-reset/route.ts",
    unknown.mocks,
  );
  await assert.rejects(() => unknownRoute.POST(resetRequest()), GENERIC_RESET_REDIRECT);

  assert.equal(existing.calls.generated, 1);
  assert.equal(existing.calls.emailed, 1);
  assert.equal(unknown.calls.generated, 0);
  assert.equal(unknown.calls.emailed, 0);
});

test("password reset rate limiting is durable, normalized, and non-enumerating", async () => {
  const limited = resetRouteMocks({ rateLimitResult: false });
  const route = await loadTsModule("app/api/auth/password-reset/route.ts", limited.mocks);

  await assert.rejects(() => route.POST(resetRequest()), GENERIC_RESET_REDIRECT);

  assert.equal(limited.calls.generated, 0);
  assert.equal(limited.calls.limiter.length, 1);
  assert.equal(limited.calls.limiter[0].windowSeconds, 3600);
  assert.equal(limited.calls.limiter[0].maxPerEmail, 5);
  assert.equal(limited.calls.limiter[0].maxPerIp, 20);
  assert.equal(
    limited.calls.limiter[0].emailHash,
    createHmac("sha256", "test-rate-limit-secret")
      .update("email:owner@example.com")
      .digest("hex"),
  );
  assert.equal(
    limited.calls.limiter[0].ipHash,
    createHmac("sha256", "test-rate-limit-secret")
      .update("ip:203.0.113.9")
      .digest("hex"),
  );
});

test("password reset fails closed but remains generic when the limiter is unavailable", async () => {
  const unavailable = resetRouteMocks({ rateLimitError: new Error("database unavailable") });
  const route = await loadTsModule("app/api/auth/password-reset/route.ts", unavailable.mocks);

  await assert.rejects(() => route.POST(resetRequest()), GENERIC_RESET_REDIRECT);
  assert.equal(unavailable.calls.generated, 0);
  assert.equal(unavailable.calls.emailed, 0);
});

test("CSP report ingestion bounds payloads and stores only origins", async () => {
  const route = await loadTsModule("app/api/security/csp-report/route.ts");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);

  try {
    const response = await route.POST(
      new Request("https://www.relay-nw.com/api/security/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body: JSON.stringify({
          "csp-report": {
            "effective-directive": "connect-src",
            "blocked-uri": "https://unexpected.example/private/path?secret=value",
            "document-uri": "https://www.relay-nw.com/leads/private",
          },
        }),
      }),
    );

    assert.equal(response.status, 204);
    assert.equal(warnings[0][1].blockedOrigin, "https://unexpected.example");
    assert.equal(warnings[0][1].documentOrigin, "https://www.relay-nw.com");
    assert.doesNotMatch(JSON.stringify(warnings), /private\/path|secret=value/);
  } finally {
    console.warn = originalWarn;
  }
});
