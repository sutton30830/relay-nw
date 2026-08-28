import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Tests for the June 2026 audit fixes:
// 1. Deterministic cooldown winner for concurrent missed calls (no mutual skip, no double text)
// 2. resolveAccountSafely downgrades resolution errors to "unresolved" (webhooks stay visible)
// 3. Email wildcard escaping in account_users lookup (tenant isolation)

async function loadTsModule(path, mocks) {
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

const notificationPreferencesMock = {
  DEFAULT_OWNER_NOTIFICATION_PREFERENCES: {
    missedCall: { email: true, sms: true },
    voicemailReady: { email: true, sms: false },
    inboundReply: { email: true, sms: true },
    urgentVoicemailSms: true,
  },
  normalizeOwnerNotificationPreferences: (value) => value ?? {
    missedCall: { email: true, sms: true },
    voicemailReady: { email: true, sms: false },
    inboundReply: { email: true, sms: true },
    urgentVoicemailSms: true,
  },
};

// --- 1. Deterministic cooldown winner (lib/supabase/messages.ts) ---

function leadsQueryFake(rows) {
  function builder() {
    const filters = [];
    const api = {
      select: () => api,
      eq: (column, value) => (filters.push((row) => row[column] === value), api),
      neq: (column, value) => (filters.push((row) => row[column] !== value), api),
      in: (column, values) => (filters.push((row) => values.includes(row[column])), api),
      gte: (column, value) => (filters.push((row) => row[column] >= value), api),
      limit: async () => ({
        data: rows.filter((row) => filters.every((matches) => matches(row))),
        error: null,
      }),
    };
    return api;
  }

  return { from: () => builder() };
}

async function loadMessagesModule(rows) {
  return loadTsModule("lib/supabase/messages.ts", {
    "./client": {
      isPlaceholderSupabaseConfig: () => false,
      shouldSkipDatabaseWrite: () => false,
      supabaseAdmin: leadsQueryFake(rows),
      throwIfSupabaseError: (error) => {
        if (error) throw error;
      },
    },
    "./tenant": { assertAccountId: (value) => value },
    "./types": {},
  });
}

function pendingLead(id, createdAt, overrides = {}) {
  return {
    id,
    created_at: createdAt,
    phone: "+12065550123",
    source: "missed_call",
    account_id: "acct-1",
    sms_status: "pending",
    ...overrides,
  };
}

const SINCE = new Date("2026-06-10T00:00:00Z");
const T1 = "2026-06-10T12:00:00.000Z";
const T2 = "2026-06-10T12:00:00.250Z";

test("concurrent missed calls: exactly one lead sends (earlier lead wins, later lead skips)", async () => {
  // Both leads are already inserted as "pending" before either check runs — the exact
  // interleaving that previously made BOTH skip and lose the caller entirely.
  const rows = [pendingLead("lead-a", T1), pendingLead("lead-b", T2)];
  const { hasRecentMissedCallSms } = await loadMessagesModule(rows);

  const aBlocked = await hasRecentMissedCallSms("+12065550123", SINCE, "acct-1", "lead-a", T1);
  const bBlocked = await hasRecentMissedCallSms("+12065550123", SINCE, "acct-1", "lead-b", T2);

  assert.equal(aBlocked, false, "earlier lead must send");
  assert.equal(bBlocked, true, "later lead must skip");
});

test("identical created_at: id tie-break still yields exactly one winner", async () => {
  const rows = [pendingLead("lead-a", T1), pendingLead("lead-b", T1)];
  const { hasRecentMissedCallSms } = await loadMessagesModule(rows);

  const aBlocked = await hasRecentMissedCallSms("+12065550123", SINCE, "acct-1", "lead-a", T1);
  const bBlocked = await hasRecentMissedCallSms("+12065550123", SINCE, "acct-1", "lead-b", T1);

  assert.equal([aBlocked, bBlocked].filter(Boolean).length, 1, "exactly one lead must be blocked");
  assert.equal(aBlocked, false, "smaller id wins the tie");
});

test("normal cooldown still applies: an older delivered lead blocks a new missed call", async () => {
  const rows = [
    pendingLead("lead-old", "2026-06-10T08:00:00.000Z", { sms_status: "delivered" }),
    pendingLead("lead-new", T2),
  ];
  const { hasRecentMissedCallSms } = await loadMessagesModule(rows);

  const blocked = await hasRecentMissedCallSms("+12065550123", SINCE, "acct-1", "lead-new", T2);
  assert.equal(blocked, true);
});

test("failed/undelivered/skipped leads never block a retry", async () => {
  const rows = [
    pendingLead("lead-f", "2026-06-10T08:00:00.000Z", { sms_status: "failed" }),
    pendingLead("lead-u", "2026-06-10T09:00:00.000Z", { sms_status: "undelivered" }),
    pendingLead("lead-s", "2026-06-10T10:00:00.000Z", { sms_status: "skipped_recent" }),
    pendingLead("lead-new", T2),
  ];
  const { hasRecentMissedCallSms } = await loadMessagesModule(rows);

  const blocked = await hasRecentMissedCallSms("+12065550123", SINCE, "acct-1", "lead-new", T2);
  assert.equal(blocked, false, "a transient failure must not permanently suppress follow-ups");
});

test("legacy call without ownLeadCreatedAt: any active competitor blocks (conservative)", async () => {
  const rows = [pendingLead("lead-x", T2), pendingLead("lead-new", T1)];
  const { hasRecentMissedCallSms } = await loadMessagesModule(rows);

  const blocked = await hasRecentMissedCallSms("+12065550123", SINCE, "acct-1", "lead-new");
  assert.equal(blocked, true);
});

// --- 2. resolveAccountSafely (lib/supabase/accounts.ts) ---

async function loadAccountsModule() {
  return loadTsModule("lib/supabase/accounts.ts", {
    "@/lib/telephony/persistence": {
      LEGACY_TELEPHONY_PROVIDER_ID: "twilio",
      persistedTelephonyProviderId: () => "twilio",
      mapLegacyTelephonyRow: (row) => ({
        relayPhoneNumber: row.phone_number ?? "",
        providerNumberId: null,
      }),
      legacyProviderValue: (identifier) => identifier.value,
    },
    "@/lib/notification-preferences": notificationPreferencesMock,
    "@/lib/billing": {
      normalizeCommercialOffer: (value) =>
        value === "founding_pilot" ? "founding_pilot" : "standard",
    },
    "@/lib/customer-experience-contract": {},
    "@/lib/env": {
      env: {
        defaultAccountSlug: "relay-nw",
        businessName: "Test",
        callMode: "direct",
        smsEnabled: false,
        intakeUrl: "http://localhost/intake",
        schedulingUrl: "http://localhost/book",
        smsTemplate: null,
        missedCallVoiceMessage: null,
        missedCallVoiceName: "Polly.Joanna-Neural",
        missedCallGreetingAudioUrl: null,
        voicemailMaxSeconds: 60,
        dialTimeoutSeconds: 18,
        missedCallSmsCooldownHours: 24,
        twilioPhoneNumber: "+15551234567",
        ownerPhoneNumber: "+15557654321",
      },
    },
    "@/lib/phone": { normalizePhoneNumber: (value) => value },
    "./client": {
      isPlaceholderSupabaseConfig: () => true,
      shouldSkipDatabaseWrite: () => true,
      supabaseAdmin: {},
      throwIfSupabaseError: () => {},
    },
    "./tenant": {
      assertAccountId: (accountId) => {
        if (!accountId) throw new Error("Missing account_id");
        return accountId;
      },
    },
  });
}

test("resolveAccountSafely passes resolved accounts through untouched", async () => {
  const { resolveAccountSafely } = await loadAccountsModule();
  const resolution = { status: "resolved", account: { accountId: "acct-1" } };

  assert.deepEqual(await resolveAccountSafely(async () => resolution, "voice"), resolution);
});

test("resolveAccountSafely downgrades a thrown resolution error to unresolved instead of crashing the webhook", async () => {
  const { resolveAccountSafely } = await loadAccountsModule();

  const result = await resolveAccountSafely(async () => {
    throw new Error("supabase connection refused");
  }, "voice");

  assert.equal(result.status, "unresolved");
  assert.match(result.reason, /account_resolution_error/);
  assert.match(result.reason, /connection refused/);
});

// --- 3. Email wildcard escaping (lib/auth.ts) ---

test("account_users email lookup escapes ilike wildcards so j_doe cannot match jadoe", async () => {
  const ilikePatterns = [];

  const accountUsersQuery = () => {
    const api = {
      select: () => api,
      eq: () => api,
      ilike: (_column, pattern) => {
        ilikePatterns.push(pattern);
        return api;
      },
      update: () => api,
      is: () => api,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return api;
  };

  const mocks = {
    "next/headers": { cookies: async () => ({ getAll: () => [], set: () => {} }) },
    "next/navigation": {
      redirect: (target) => {
        throw new Error(`redirect:${target}`);
      },
    },
    "@supabase/ssr": {
      createServerClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: "user-1",
                email: "j_doe@x.com",
                email_confirmed_at: new Date().toISOString(),
              },
            },
            error: null,
          }),
        },
      }),
    },
    "@/lib/env": { env: { supabaseUrl: "http://localhost", supabaseAnonKey: "anon" } },
    "@/lib/ops-actions": { canPerformOpsAction: () => true },
    "@/lib/supabase": {
      supabaseAdmin: { from: () => accountUsersQuery() },
      getAccountConfigByAccountId: async () => null,
      getPlatformOperatorByUserId: async () => null,
    },
  };

  const { getAccountUserSession } = await loadTsModule("lib/auth.ts", mocks);
  await getAccountUserSession();

  assert.equal(ilikePatterns.length, 1, "email fallback lookup should run");
  assert.equal(ilikePatterns[0], "j\\_doe@x.com", "underscore must be escaped in the ilike pattern");
});
