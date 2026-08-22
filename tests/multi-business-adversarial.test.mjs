import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  BUSINESS_A,
  BUSINESS_B,
  BUSINESSES,
  createTwoBusinessFixture,
} from "./helpers/two-business-fixture.mjs";

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
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, {
    filename: path,
  }).runInThisContext()(require, module, module.exports);
  return module.exports;
}

function consistentEvidence(evidence) {
  const resolved = evidence.filter((item) => item.resolution.status === "resolved");
  const accountIds = new Set(
    resolved.map((item) => item.resolution.account?.accountId ?? null),
  );
  if (accountIds.has(null) || accountIds.size > 1) {
    return {
      status: "unresolved",
      reason: "provider_account_evidence_mismatch",
      lookupValue: null,
    };
  }
  return resolved[0]?.resolution ?? evidence[0]?.resolution ?? {
    status: "unresolved",
    reason: "provider_account_evidence_missing",
    lookupValue: null,
  };
}

function resolved(account) {
  return account
    ? { status: "resolved", account }
    : { status: "unresolved", reason: "not_registered", lookupValue: null };
}

function postForm(route, url, values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return route.POST(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }));
}

function accountRows(state, accountId) {
  return Object.fromEntries(
    Object.entries(state)
      .filter(([, rows]) => Array.isArray(rows))
      .map(([table, rows]) => [
        table,
        rows.filter((row) => row.account_id === accountId),
      ]),
  );
}

test("the adversarial fixture has two non-overlapping businesses and every customer state", () => {
  const { state, sessionFor } = createTwoBusinessFixture();
  const expectedTenantTables = [
    "accounts",
    "account_settings",
    "account_carrier_profiles",
    "account_phone_numbers",
    "account_users",
    "account_audit_events",
    "leads",
    "inbound_messages",
    "calls",
    "messages",
    "opt_outs",
    "webhook_events",
    "stripe_events",
  ];

  for (const table of expectedTenantTables) {
    assert.ok(table in state, `${table} must exist in the two-business fixture`);
  }

  for (const field of [
    "accountId",
    "slug",
    "relayNumber",
    "publicNumber",
    "customerPhone",
    "optOutPhone",
    "callSid",
    "messageSid",
    "recordingSid",
    "leadId",
  ]) {
    assert.notEqual(BUSINESS_A[field], BUSINESS_B[field], `${field} must differ`);
  }

  assert.notEqual(BUSINESS_A.owner.userId, BUSINESS_B.owner.userId);
  assert.notEqual(sessionFor(BUSINESS_A, "viewer").accountId, BUSINESS_B.accountId);
  assert.notEqual(
    state.accounts.find((row) => row.id === BUSINESS_A.accountId).billing_status,
    state.accounts.find((row) => row.id === BUSINESS_B.accountId).billing_status,
  );
  assert.notEqual(
    state.account_settings.find((row) => row.account_id === BUSINESS_A.accountId).a2p_registration_status,
    state.account_settings.find((row) => row.account_id === BUSINESS_B.accountId).a2p_registration_status,
  );
  assert.notEqual(
    state.accounts.find((row) => row.id === BUSINESS_A.accountId).ops_blocked_by,
    state.accounts.find((row) => row.id === BUSINESS_B.accountId).ops_blocked_by,
  );

  const aRows = accountRows(state, BUSINESS_A.accountId);
  const bRows = accountRows(state, BUSINESS_B.accountId);
  for (const table of [
    "account_settings",
    "account_carrier_profiles",
    "account_phone_numbers",
    "account_users",
    "account_audit_events",
    "leads",
    "inbound_messages",
    "calls",
    "messages",
    "opt_outs",
  ]) {
    assert.ok(aRows[table].length > 0, `${table} must include Business A`);
    assert.ok(bRows[table].length > 0, `${table} must include Business B`);
  }
});

test("Business A cannot mutate Business B by record ID or request body", async () => {
  const fixture = createTwoBusinessFixture();
  const session = fixture.sessionFor(BUSINESS_A, "owner");
  const mutations = [];
  const route = await loadTsModule("app/api/leads/[id]/route.ts", {
    "@/lib/auth": {
      requireWriteAccessJson: async () => ({ session, response: null }),
    },
    "@/lib/supabase": {
      updateLead: async (input) => {
        const row = fixture.state.leads.find(
          (lead) => lead.id === input.id && lead.account_id === input.accountId,
        );
        if (row) {
          Object.assign(row, { status: input.status, notes: input.notes });
          mutations.push({ action: "update", accountId: input.accountId, id: input.id });
        }
      },
      deleteLead: async (id, accountId) => {
        const row = fixture.state.leads.find(
          (lead) => lead.id === id && lead.account_id === accountId,
        );
        if (row) {
          row.deleted_at = new Date().toISOString();
          mutations.push({ action: "delete", accountId, id });
        }
      },
    },
  });
  const beforeB = structuredClone(
    fixture.state.leads.find((lead) => lead.id === BUSINESS_B.leadId),
  );

  const patchResponse = await route.PATCH(
    new Request("https://relay.test/api/leads/forged", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: BUSINESS_B.accountId,
        status: "dead",
        notes: "forged cross-account update",
      }),
    }),
    { params: Promise.resolve({ id: BUSINESS_B.leadId }) },
  );
  const deleteResponse = await route.DELETE(
    new Request("https://relay.test/api/leads/forged", { method: "DELETE" }),
    { params: Promise.resolve({ id: BUSINESS_B.leadId }) },
  );

  assert.equal(patchResponse.status, 200);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(
    fixture.state.leads.find((lead) => lead.id === BUSINESS_B.leadId),
    beforeB,
  );
  assert.deepEqual(mutations, []);
});

function redirect(location) {
  throw Object.assign(new Error(`REDIRECT:${location}`), { location });
}

async function expectRedirect(fn) {
  try {
    await fn();
    assert.fail("Expected redirect");
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) throw error;
    return error.location;
  }
}

test("settings, billing, Operations, and team endpoints derive their tenant from authority—not forged fields", async () => {
  const fixture = createTwoBusinessFixture();
  const sessionA = fixture.sessionFor(BUSINESS_A, "owner");
  const settingsUpdates = [];
  const settingsRoute = await loadTsModule("app/api/settings/route.ts", {
    "next/navigation": { redirect },
    "@/lib/auth": { requireAccountUser: async () => sessionA },
    "@/lib/billing-activation": {
      activateStripeTrialForAccount: async () => {
        throw new Error("Texting was already enabled; activation must not run");
      },
    },
    "@/lib/billing": { isSetupFeeSettled: () => true },
    "@/lib/phone": { normalizePhoneNumber: (value) => value },
    "@/lib/audit": { diffSettingsForAudit: () => [] },
    "@/lib/notification-preferences": {
      serializeOwnerNotificationPreferences: (preferences) => ({
        missed_call: preferences.missedCall,
        voicemail_ready: preferences.voicemailReady,
        inbound_reply: preferences.inboundReply,
        urgent_voicemail_sms: preferences.urgentVoicemailSms,
      }),
    },
    "@/lib/supabase": {
      getA2pRegistrationStatus: async () => "approved",
      getAccountBillingRecord: async () => {
        throw new Error("Existing enabled SMS does not require billing lookup");
      },
      recordAccountAuditEvents: async (input) => {
        assert.equal(input.accountId, BUSINESS_A.accountId);
      },
      updateAccountSettings: async (accountId, update) => {
        settingsUpdates.push({ accountId, update });
        const row = fixture.state.account_settings.find(
          (settings) => settings.account_id === accountId,
        );
        if (row) Object.assign(row, update);
      },
    },
  });
  const settingsForm = new FormData();
  Object.entries({
    account_id: BUSINESS_B.accountId,
    business_name: "Alpha Plumbing Updated",
    owner_name: "Alpha Owner",
    owner_phone_number: BUSINESS_A.owner.phone,
    owner_email: BUSINESS_A.owner.email,
    public_business_number: BUSINESS_A.publicNumber,
    greeting_preference: "generated",
    dial_timeout_seconds: "18",
    voicemail_max_seconds: "60",
    missed_call_sms_cooldown_hours: "24",
    typical_job_value_dollars: "450",
    sms_enabled: "on",
  }).forEach(([key, value]) => settingsForm.set(key, value));
  const beforeBSettings = structuredClone(
    fixture.state.account_settings.find(
      (settings) => settings.account_id === BUSINESS_B.accountId,
    ),
  );

  assert.equal(
    await expectRedirect(() => settingsRoute.POST(new Request(
      "https://relay.test/api/settings?" + new URLSearchParams({
        account_id: BUSINESS_B.accountId,
        relay_number: BUSINESS_B.relayNumber,
        public_number: BUSINESS_B.publicNumber,
      }),
      { method: "POST", body: settingsForm },
    ))),
    "/settings?saved=1",
  );
  assert.equal(settingsUpdates[0].accountId, BUSINESS_A.accountId);
  assert.deepEqual(
    fixture.state.account_settings.find(
      (settings) => settings.account_id === BUSINESS_B.accountId,
    ),
    beforeBSettings,
  );

  const billingLookups = [];
  const portalInputs = [];
  const portalRoute = await loadTsModule("app/api/billing/portal/route.ts", {
    "next/navigation": { redirect },
    "@/lib/auth": { requireAccountUser: async () => sessionA },
    "@/lib/env": { env: { appBaseUrl: "https://relay.test" } },
    "@/lib/stripe-billing": {
      createStripePortalSession: async (input) => {
        portalInputs.push(input);
        return { url: "https://billing.stripe.test/alpha" };
      },
    },
    "@/lib/supabase": {
      getAccountBillingRecord: async (accountId) => {
        billingLookups.push(accountId);
        const account = fixture.state.accounts.find((row) => row.id === accountId);
        return { stripeCustomerId: account?.stripe_customer_id ?? null };
      },
      recordPlatformAuditEvent: async () => {},
      updateAccountBillingRecord: async () => {},
    },
  });
  assert.equal(
    await expectRedirect(() => portalRoute.POST(new Request(
      "https://relay.test/api/billing/portal?account_id=" + BUSINESS_B.accountId,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "reply-alpha-0001" },
        body: JSON.stringify({ accountId: BUSINESS_B.accountId }),
      },
    ))),
    "https://billing.stripe.test/alpha",
  );
  assert.deepEqual(billingLookups, [BUSINESS_A.accountId]);
  assert.equal(portalInputs[0].stripeCustomerId, "cus_alpha");

  const operationsUpdates = [];
  const opsRoute = await loadTsModule("app/api/ops/calls/route.ts", {
    "next/navigation": { redirect },
    "@/lib/auth": {
      requirePlatformOperatorAction: async () => ({
        userId: "platform-super-admin",
        email: "operator@relay.test",
        role: "super_admin",
      }),
    },
    "@/lib/ops-actions": {
      OPS_ACTIONS: {
        onboardingPause: "account.onboarding.pause",
        onboardingResume: "account.onboarding.resume",
        paidServicePause: "account.paid_service.pause",
        accountClose: "account.close",
        accountReopen: "account.reopen",
      },
      hasExplicitOpsConfirmation: (value) => value === "confirmed",
    },
    "@/lib/supabase": {
      getOpsAccountBySlug: async (slug) => {
        const business = BUSINESSES.find((item) => item.slug === slug);
        if (!business) return null;
        const row = fixture.state.accounts.find((item) => item.id === business.accountId);
        return {
          accountId: business.accountId,
          accountSlug: business.slug,
          businessName: business.name,
          accountStatus: row.status,
          technicalStatus: row.onboarding_status,
        };
      },
      getOpsBillingAccountBySlug: async (slug) => {
        const business = BUSINESSES.find((item) => item.slug === slug);
        if (!business) return null;
        const row = fixture.state.accounts.find((item) => item.id === business.accountId);
        return {
          accountId: business.accountId,
          stripeSubscriptionStatus: row.stripe_subscription_id ? "active" : null,
        };
      },
      recordAccountAuditEvents: async (input) => {
        assert.equal(input.accountId, BUSINESS_A.accountId);
      },
      recordPlatformAuditEvent: async (input) => {
        assert.equal(input.targetAccountId, BUSINESS_A.accountId);
      },
      updateAccountOperationalState: async (input) => {
        operationsUpdates.push(input);
        const row = fixture.state.accounts.find((account) => account.id === input.accountId);
        if (row) {
          if (input.accountStatus) row.status = input.accountStatus;
          if (input.technicalStatus) row.onboarding_status = input.technicalStatus;
        }
      },
    },
  });
  const closeForm = new FormData();
  closeForm.set("account_slug", BUSINESS_A.slug);
  closeForm.set("account_id", BUSINESS_B.accountId);
  closeForm.set("account_control", "close_account");
  closeForm.set("reason", "Requested by the Alpha owner");
  closeForm.set("confirmation", "confirmed");
  const beforeBAccount = structuredClone(
    fixture.state.accounts.find((account) => account.id === BUSINESS_B.accountId),
  );
  assert.equal(
    await expectRedirect(() => opsRoute.POST(new Request(
      "https://relay.test/api/ops/calls",
      { method: "POST", body: closeForm },
    ))),
    `/ops/accounts/${BUSINESS_A.slug}?calls=saved`,
  );
  assert.deepEqual(operationsUpdates, [{
    accountId: BUSINESS_A.accountId,
    accountStatus: "archived",
    technicalStatus: "closed",
  }]);
  assert.deepEqual(
    fixture.state.accounts.find((account) => account.id === BUSINESS_B.accountId),
    beforeBAccount,
  );

  let teamMutationCalled = false;
  const teamRoute = await loadTsModule("app/api/ops/team/route.ts", {
    "next/navigation": { redirect },
    "@/lib/auth": {
      requirePlatformOperatorAction: async () => {
        throw new Error("Forbidden");
      },
    },
    "@/lib/ops-actions": { OPS_ACTIONS: { teamManage: "team.manage" } },
    "@/lib/supabase": new Proxy({}, {
      get() {
        return async () => {
          teamMutationCalled = true;
        };
      },
    }),
  });
  const teamForm = new FormData();
  teamForm.set("action", "revoke");
  teamForm.set("user_id", BUSINESS_B.users.owner);
  await assert.rejects(
    () => teamRoute.POST(new Request(
      "https://relay.test/api/ops/team",
      { method: "POST", body: teamForm },
    )),
    /Forbidden/,
  );
  assert.equal(teamMutationCalled, false);
});

async function loadReplyRoute(fixture, business) {
  const session = fixture.sessionFor(business, "owner");
  return loadTsModule("app/api/leads/[id]/reply/route.ts", {
    "@/lib/auth": {
      requireWriteAccessJson: async () => ({ session, response: null }),
    },
    "@/lib/env": { env: { appBaseUrl: "https://relay.test" } },
    "@/lib/supabase": {
      getLeadByIdForAccount: async (accountId, id) =>
        fixture.state.leads.find(
          (lead) => lead.account_id === accountId && lead.id === id,
        ) ?? null,
      isOptedOut: async (phone, accountId) =>
        fixture.state.opt_outs.some(
          (row) => row.account_id === accountId && row.phone === phone,
        ),
      createMessageIfNew: async (input) => {
        if (
          fixture.state.messages.some(
            (row) =>
              row.account_id === input.accountId &&
              row.twilio_message_sid === input.twilioMessageSid,
          )
        ) {
          return { inserted: false };
        }
        fixture.state.messages.push({
          id: crypto.randomUUID(),
          account_id: input.accountId,
          lead_id: input.leadId,
          twilio_message_sid: input.twilioMessageSid,
          direction: input.direction,
          from_phone: input.fromPhone,
          to_phone: input.toPhone,
          body: input.body,
          status: input.status,
        });
        return { inserted: true };
      },
      updateLead: async (input) => {
        const lead = fixture.state.leads.find(
          (row) => row.account_id === input.accountId && row.id === input.id,
        );
        if (lead) lead.status = input.status;
      },
    },
    "@/lib/twilio": {
      phoneLast4: (value) => String(value ?? "").slice(-4),
      twilioClient: {
        messages: {
          create: async (input) => {
            const sid = `SM${String(fixture.state.providerActions.length + 1).padStart(32, "0")}`;
            fixture.state.providerActions.push({
              kind: "manual_sms",
              accountId: business.accountId,
              sid,
              ...input,
            });
            return { sid, status: "queued" };
          },
        },
      },
    },
  });
}

test("concurrent replies and recording playback remain in the authenticated account", async () => {
  const fixture = createTwoBusinessFixture();
  const [routeA, routeB] = await Promise.all([
    loadReplyRoute(fixture, BUSINESS_A),
    loadReplyRoute(fixture, BUSINESS_B),
  ]);

  const [replyA, replyB, forgedReply] = await Promise.all([
    routeA.POST(
      new Request("https://relay.test/api/leads/a/reply", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "reply-alpha-0001" },
        body: JSON.stringify({ body: "Alpha reply" }),
      }),
      { params: Promise.resolve({ id: BUSINESS_A.leadId }) },
    ),
    routeB.POST(
      new Request("https://relay.test/api/leads/b/reply", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "reply-bravo-0001" },
        body: JSON.stringify({ body: "Bravo reply" }),
      }),
      { params: Promise.resolve({ id: BUSINESS_B.leadId }) },
    ),
    routeA.POST(
      new Request("https://relay.test/api/leads/forged/reply", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "reply-forged-001" },
        body: JSON.stringify({ body: "Cross-account reply" }),
      }),
      { params: Promise.resolve({ id: BUSINESS_B.leadId }) },
    ),
  ]);

  assert.equal(replyA.status, 200);
  assert.equal(replyB.status, 200);
  assert.equal(forgedReply.status, 404);
  assert.deepEqual(
    fixture.state.providerActions.map((action) => [
      action.accountId,
      action.from,
      action.to,
    ]).sort(),
    [
      [BUSINESS_A.accountId, BUSINESS_A.relayNumber, BUSINESS_A.customerPhone],
      [BUSINESS_B.accountId, BUSINESS_B.relayNumber, BUSINESS_B.customerPhone],
    ].sort(),
  );

  const recordingFetches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    recordingFetches.push(String(url));
    return new Response("audio", {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };

  try {
    async function recordingRoute(business) {
      return loadTsModule("app/api/recordings/[recordingSid]/route.ts", {
        "@/lib/auth": {
          requireAccountUserJson: async () => ({
            session: fixture.sessionFor(business),
            response: null,
          }),
        },
        "@/lib/env": {
          env: {
            twilioAccountSid: "ACfixture",
            twilioAuthToken: "fixture-token",
          },
        },
        "@/lib/supabase": {
          getLeadRecordingForPlayback: async (recordingSid, accountId) =>
            fixture.state.leads.find(
              (lead) =>
                lead.account_id === accountId &&
                lead.recording_sid === recordingSid,
            ) ?? null,
        },
        "@/lib/twilio": {
          isTrustedTwilioMediaUrl: (url) =>
            typeof url === "string" && url.startsWith("https://api.twilio.com/"),
        },
      });
    }

    const [recordingA, recordingB] = await Promise.all([
      recordingRoute(BUSINESS_A),
      recordingRoute(BUSINESS_B),
    ]);
    const [playA, playB, crossPlay] = await Promise.all([
      recordingA.GET(
        new Request("https://relay.test/api/recordings/a"),
        { params: Promise.resolve({ recordingSid: BUSINESS_A.recordingSid }) },
      ),
      recordingB.GET(
        new Request("https://relay.test/api/recordings/b"),
        { params: Promise.resolve({ recordingSid: BUSINESS_B.recordingSid }) },
      ),
      recordingA.GET(
        new Request("https://relay.test/api/recordings/forged"),
        { params: Promise.resolve({ recordingSid: BUSINESS_B.recordingSid }) },
      ),
    ]);

    assert.equal(playA.status, 200);
    assert.equal(playB.status, 200);
    assert.equal(crossPlay.status, 404);
    assert.equal(recordingFetches.length, 2);
    assert.ok(recordingFetches.some((url) => url.includes(BUSINESS_A.recordingSid)));
    assert.ok(recordingFetches.some((url) => url.includes(BUSINESS_B.recordingSid)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent duplicate missed calls create one lead and one automatic caller text per business", async () => {
  const fixture = createTwoBusinessFixture();
  const seenCalls = new Set();
  const leadByCall = new Map();
  const newCalls = [
    { business: BUSINESS_A, callSid: `CA${"e".repeat(32)}` },
    { business: BUSINESS_B, callSid: `CA${"f".repeat(32)}` },
  ];
  const supabase = {
    assertTenantAccount: (account) => {
      if (!account?.accountId) throw new Error("Missing tenant");
      return account;
    },
    createMissedCallLeadIfNew: async (input) => {
      const key = `${input.accountId}:${input.callSid}`;
      if (seenCalls.has(key)) return { inserted: false, leadId: null };
      seenCalls.add(key);
      const leadId = crypto.randomUUID();
      leadByCall.set(key, leadId);
      fixture.state.leads.push({
        id: leadId,
        account_id: input.accountId,
        call_sid: input.callSid,
        phone: input.phone,
        message: input.message,
        status: "new",
        sms_status: "pending",
      });
      return {
        inserted: true,
        leadId,
        createdAt: new Date().toISOString(),
        becameLive: false,
      };
    },
    updateCallForMissedLead: async () => {},
    hasRecentMissedCallSms: async () => false,
    isOptedOut: async () => false,
    updateLeadSmsStatus: async (input) => {
      const row = fixture.state.leads.find(
        (lead) => lead.account_id === input.accountId && lead.id === input.id,
      );
      if (row) {
        row.sms_status = input.smsStatus;
        row.twilio_message_sid = input.twilioMessageSid ?? null;
      }
    },
    createMessageIfNew: async (input) => {
      fixture.state.messages.push({
        id: crypto.randomUUID(),
        account_id: input.accountId,
        lead_id: input.leadId,
        twilio_message_sid: input.twilioMessageSid,
        direction: input.direction,
        from_phone: input.fromPhone,
        to_phone: input.toPhone,
        body: input.body,
        status: input.status,
      });
      return { inserted: true };
    },
  };
  const missedCall = await loadTsModule("lib/missed-call.ts", {
    "@/lib/env": { env: { appBaseUrl: "https://relay.test" } },
    "@/lib/phone": { normalizePhoneNumber: (value) => value },
    "@/lib/supabase": supabase,
    "@/lib/supabase/accounts": {
      envAccountConfig: () => {
        throw new Error("Explicit account required");
      },
    },
    "@/lib/twilio": {
      missedCallSmsBodyForAccount: (account) => `Missed call for ${account.businessName}`,
      phoneLast4: (value) => String(value ?? "").slice(-4),
      twilioClient: {
        messages: {
          create: async (input) => {
            const sid = `SM${String(fixture.state.providerActions.length + 1).padStart(32, "1")}`;
            fixture.state.providerActions.push({ kind: "missed_call_sms", sid, ...input });
            return { sid };
          },
        },
      },
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async () => {},
      notifyOwnerNewMissedCallLead: async (input) => {
        fixture.state.ownerNotifications.push(input);
      },
    },
    "@/lib/web-push": {
      notifyOwnerByWebPush: async () => ({ attempted: 0, delivered: 0, disabled: 0 }),
    },
  });

  await Promise.all(newCalls.flatMap(({ business, callSid }) => {
    const account = fixture.accountById(business.accountId);
    const input = {
      account,
      callerPhone: business.customerPhone,
      callSid,
      message: null,
    };
    return [missedCall.handleMissedCall(input), missedCall.handleMissedCall(input)];
  }));

  for (const { business, callSid } of newCalls) {
    const leads = fixture.state.leads.filter(
      (lead) => lead.account_id === business.accountId && lead.call_sid === callSid,
    );
    assert.equal(leads.length, 1);
    const callerTexts = fixture.state.providerActions.filter(
      (action) =>
        action.to === business.customerPhone &&
        action.from === business.relayNumber,
    );
    assert.equal(callerTexts.length, 1);
  }
});

function twilioRouteMocks(fixture) {
  const webhookLogs = [];
  const unresolved = [];
  const twilio = {
    formDataToRecord: (form) => Object.fromEntries(
      [...form.entries()].map(([key, value]) => [key, String(value)]),
    ),
    logUnsignedTwilioWebhook: async () => {},
    phoneLast4: (value) => String(value ?? "").slice(-4),
    rejectInvalidTwilioSignature: () => new Response("invalid", { status: 403 }),
    summarizeTwilioRequest: () => ({}),
    validateTwilioWebhook: () => ({
      shouldReject: false,
      wasAllowedByOverride: false,
      candidateUrls: [],
      hasSignature: true,
      matchedUrl: "https://relay.test/webhook",
    }),
  };
  const supabaseBase = {
    assertTenantAccount: (account) => {
      if (!account?.accountId) throw new Error("Missing tenant");
      return account;
    },
    resolveAccountSafely: async (fn) => fn(),
    resolveAccountByCallSid: async (sid) => resolved(fixture.accountByCallSid(sid)),
    resolveAccountByMessageSid: async (sid) => resolved(fixture.accountByMessageSid(sid)),
    resolveAccountByTwilioNumber: async (phone) =>
      resolved(fixture.accountByRelayNumber(phone)),
    resolveConsistentAccountEvidence: consistentEvidence,
    logWebhookEvent: async (input) => webhookLogs.push(input),
  };
  return {
    webhookLogs,
    unresolved,
    twilio,
    supabaseBase,
    unresolvedHandler: {
      handleUnresolvedTwilioAccount: async (input) => {
        unresolved.push(input);
        return new Response("<Response></Response>", {
          status: 200,
          headers: { "content-type": "text/xml" },
        });
      },
    },
    twiml: {
      emptyTwiml: () => "<Response></Response>",
      helpReplyTwiml: ({ businessName }) => `<Response>${businessName}</Response>`,
      twimlResponse: (xml) => new Response(xml, {
        status: 200,
        headers: { "content-type": "text/xml" },
      }),
    },
  };
}

test("concurrent inbound SMS is deduplicated per account and conflicting SID/number evidence fails closed", async () => {
  const fixture = createTwoBusinessFixture();
  const common = twilioRouteMocks(fixture);
  const inboundSids = {
    [BUSINESS_A.accountId]: `SM${"e".repeat(32)}`,
    [BUSINESS_B.accountId]: `SM${"f".repeat(32)}`,
  };
  const claimedInbound = new Set();
  const route = await loadTsModule("app/api/twilio/sms/route.ts", {
    "@/lib/env": {
      env: { allowUnsignedTwilioWebhooks: false, appBaseUrl: "https://relay.test" },
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async () => {},
      notifyOwnerInboundReply: async (input) =>
        fixture.state.ownerNotifications.push(input),
      notifyOwnerOptOut: async () => {},
    },
    "@/lib/phone": { normalizePhoneNumber: (value) => value },
    "@/lib/supabase": {
      ...common.supabaseBase,
      createInboundMessageIfNew: async (input) => {
        const key = `${input.accountId}:${input.messageSid}`;
        if (claimedInbound.has(key)) return { inserted: false };
        claimedInbound.add(key);
        fixture.state.inbound_messages.push({
          id: crypto.randomUUID(),
          account_id: input.accountId,
          message_sid: input.messageSid,
          from_phone: input.fromPhone,
          to_phone: input.toPhone,
          body: input.body,
        });
        return { inserted: true };
      },
      createMessageIfNew: async (input) => {
        if (
          fixture.state.messages.some(
            (row) =>
              row.account_id === input.accountId &&
              row.twilio_message_sid === input.twilioMessageSid,
          )
        ) return { inserted: false };
        fixture.state.messages.push({
          id: crypto.randomUUID(),
          account_id: input.accountId,
          twilio_message_sid: input.twilioMessageSid,
          direction: input.direction,
          from_phone: input.fromPhone,
          to_phone: input.toPhone,
          body: input.body,
          status: input.status,
        });
        return { inserted: true };
      },
      clearOptOut: async () => {},
      recordOptOut: async () => {},
    },
    "@/lib/twilio": {
      ...common.twilio,
      twilioClient: {
        messages: {
          create: async (input) => {
            fixture.state.providerActions.push({ kind: "owner_forward", ...input });
            return { sid: `SM${"9".repeat(32)}` };
          },
        },
      },
    },
    "@/lib/twilio/unresolved-account": common.unresolvedHandler,
    "@/lib/twiml": common.twiml,
  });

  await Promise.all(BUSINESSES.flatMap((business) => {
    const input = {
      MessageSid: inboundSids[business.accountId],
      To: business.relayNumber,
      From: business.customerPhone,
      Body: `${business.name} reply`,
    };
    return [
      postForm(route, "https://relay.test/api/twilio/sms", input),
      postForm(route, "https://relay.test/api/twilio/sms", input),
    ];
  }));

  for (const business of BUSINESSES) {
    assert.equal(
      fixture.state.inbound_messages.filter(
        (row) =>
          row.account_id === business.accountId &&
          row.message_sid === inboundSids[business.accountId],
      ).length,
      1,
    );
    assert.equal(
      fixture.state.providerActions.filter(
        (action) =>
          action.kind === "owner_forward" &&
          action.from === business.relayNumber &&
          action.to === business.owner.phone,
      ).length,
      1,
    );
  }

  const beforeActions = fixture.state.providerActions.length;
  await postForm(route, "https://relay.test/api/twilio/sms", {
    MessageSid: inboundSids[BUSINESS_A.accountId],
    To: BUSINESS_B.relayNumber,
    From: BUSINESS_B.customerPhone,
    Body: "forged cross-account replay",
  });
  assert.equal(fixture.state.providerActions.length, beforeActions);
  assert.equal(common.unresolved.length, 1);
  assert.equal(
    common.unresolved[0].resolution.reason,
    "provider_account_evidence_mismatch",
  );
});

test("recording and transcription callbacks stay account-scoped under concurrency and conflict", async () => {
  const fixture = createTwoBusinessFixture();
  const common = twilioRouteMocks(fixture);
  const afterTasks = [];
  const transcribed = new Set();
  const route = await loadTsModule("app/api/twilio/recording/route.ts", {
    "next/server": {
      after: (fn) => {
        const pending = Promise.resolve().then(fn);
        afterTasks.push(pending);
      },
    },
    "@/lib/env": {
      env: {
        allowUnsignedTwilioWebhooks: false,
        openaiTranscriptionModel: "fixture-transcription-model",
      },
    },
    "@/lib/email": { notifyAdminOperationalIssue: async () => {} },
    "@/lib/supabase": {
      ...common.supabaseBase,
      updateCallRecordingByCallSid: async (input) => {
        const call = fixture.state.calls.find(
          (row) =>
            row.account_id === input.accountId &&
            row.call_sid === input.callSid,
        );
        if (call) call.recording_sid = input.recordingSid;
      },
      updateLeadRecordingByCallSid: async (input) => {
        const lead = fixture.state.leads.find(
          (row) =>
            row.account_id === input.accountId &&
            row.call_sid === input.callSid,
        );
        if (!lead) return { updated: false, leadId: null, matchedBy: null };
        lead.recording_sid = input.recordingSid;
        lead.recording_status = input.recordingStatus;
        return { updated: true, leadId: lead.id, matchedBy: "call_sid" };
      },
      updateLeadVoicemailTranscription: async () => {},
    },
    "@/lib/voicemail-ai": {
      isExpectedVoicemailQualityErrorMessage: () => false,
      transcribeLeadVoicemail: async (leadId, accountId) => {
        const lead = fixture.state.leads.find(
          (row) => row.account_id === accountId && row.id === leadId,
        );
        assert.ok(lead, "transcription must receive a lead in the same account");
        const key = `${accountId}:${leadId}`;
        if (transcribed.has(key)) {
          throw new Error("Voicemail summary is already generating.");
        }
        transcribed.add(key);
        fixture.state.providerActions.push({
          kind: "transcription",
          accountId,
          leadId,
          recordingSid: lead.recording_sid,
        });
      },
    },
    "@/lib/twilio": common.twilio,
    "@/lib/twilio/unresolved-account": common.unresolvedHandler,
    "@/lib/twiml": common.twiml,
    "@/lib/phone": { normalizePhoneNumber: (value) => value },
    "@/lib/voicemail-quality": {
      NO_USABLE_VOICEMAIL_MESSAGE: "No usable voicemail",
      recordingIsTooShort: (duration) => typeof duration === "number" && duration < 3,
    },
  });

  await Promise.all(BUSINESSES.flatMap((business) => {
    const input = {
      CallSid: business.pendingCallSid,
      To: business.relayNumber,
      From: business.customerPhone,
      RecordingSid: business.pendingRecordingSid,
      RecordingUrl: `https://api.twilio.com/recordings/${business.pendingRecordingSid}`,
      RecordingDuration: "12",
      RecordingStatus: "completed",
    };
    return [
      postForm(route, "https://relay.test/api/twilio/recording", input),
      postForm(route, "https://relay.test/api/twilio/recording", input),
    ];
  }));
  await Promise.all(afterTasks);

  for (const business of BUSINESSES) {
    const actions = fixture.state.providerActions.filter(
      (action) =>
        action.kind === "transcription" &&
        action.accountId === business.accountId &&
        action.leadId === business.pendingLeadId,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].recordingSid, business.pendingRecordingSid);
  }

  const beforeB = structuredClone(
    fixture.state.leads.find((lead) => lead.id === BUSINESS_B.pendingLeadId),
  );
  await postForm(route, "https://relay.test/api/twilio/recording", {
    CallSid: BUSINESS_A.pendingCallSid,
    To: BUSINESS_B.relayNumber,
    From: BUSINESS_A.customerPhone,
    RecordingSid: `RE${"9".repeat(32)}`,
    RecordingUrl: "https://api.twilio.com/recordings/forged",
    RecordingDuration: "12",
    RecordingStatus: "completed",
  });
  assert.deepEqual(
    fixture.state.leads.find((lead) => lead.id === BUSINESS_B.pendingLeadId),
    beforeB,
  );
  assert.equal(common.unresolved.length, 1);
  assert.equal(
    common.unresolved[0].resolution.reason,
    "provider_account_evidence_mismatch",
  );
});

test("the database migration enforces non-null tenancy, account-aware references, and locked number ownership", async () => {
  const sql = await readFile(
    new URL("../docs/migrations/2026-07-29-tenant-isolation-hardening.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "account_settings",
    "account_carrier_profiles",
    "account_phone_numbers",
    "account_users",
    "account_audit_events",
    "leads",
    "opt_outs",
    "inbound_messages",
    "calls",
    "messages",
  ]) {
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table}\\s+alter column account_id set not null`, "i"),
    );
  }

  assert.match(sql, /calls_account_lead_tenant_fk/i);
  assert.match(sql, /messages_account_lead_tenant_fk/i);
  assert.match(sql, /messages_account_call_tenant_fk/i);
  assert.match(sql, /account_phone_numbers_phone_unique_idx/i);
  assert.match(sql, /leads_account_recording_sid_unique_idx/i);
  assert.match(sql, /calls_account_recording_sid_unique_idx/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /Relay number is already assigned to another account/i);
  assert.match(sql, /Relay numbers can only be released from a closed archived account/i);
  assert.match(sql, /where number\.account_id = p_account_id/i);
  assert.match(sql, /revoke all on function public\.assign_primary_account_phone_number[\s\S]*authenticated/i);
  assert.match(sql, /grant execute on function public\.assign_primary_account_phone_number[\s\S]*service_role/i);
});
