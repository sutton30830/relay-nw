import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

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
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

function pushHarness({ configured = true, sendError = null } = {}) {
  const sends = [];
  const successes = [];
  const failures = [];
  const subscriptions = [{
    id: "push-1",
    endpoint: "https://push.example.test/subscription-1",
    p256dh: "p".repeat(65),
    auth: "a".repeat(22),
    failureCount: 2,
  }];
  const sendNotification = async (...args) => {
    sends.push(args);
    if (sendError) throw sendError;
    return { statusCode: 201 };
  };

  return {
    sends,
    successes,
    failures,
    mocks: {
      "server-only": {},
      "web-push": { __esModule: true, default: { sendNotification } },
      "@/lib/env": {
        env: {
          webPushPublicKey: configured ? "public-key" : undefined,
          webPushPrivateKey: configured ? "private-key" : undefined,
          webPushContact: "mailto:test@example.com",
        },
      },
      "@/lib/supabase": {
        listActiveOwnerPushSubscriptions: async () => subscriptions,
        markOwnerPushSubscriptionSucceeded: async (input) => successes.push(input),
        markOwnerPushSubscriptionFailed: async (input) => failures.push(input),
      },
    },
  };
}

test("missed-call Web Push is A2P-independent, bounded, and privacy-minimal", async () => {
  const harness = pushHarness();
  const push = await loadTsModule("lib/web-push.ts", harness.mocks);

  const result = await push.notifyOwnerByWebPush({
    account: { accountId: "acct-1", businessName: "RYCO" },
    event: "missed_call",
    leadId: "lead-1",
    callerPhone: "+12065550123",
  });

  assert.deepEqual(result, { attempted: 1, delivered: 1, disabled: 0 });
  assert.equal(harness.sends.length, 1);
  const [, rawPayload, options] = harness.sends[0];
  const payload = JSON.parse(rawPayload);
  assert.match(payload.title, /Missed call for RYCO/);
  assert.match(payload.body, /ending in 0123/);
  assert.doesNotMatch(payload.body, /12065550123/);
  assert.equal(payload.url, "/leads/lead-1");
  assert.equal(options.timeout, 10_000);
  assert.equal(options.urgency, "high");
  assert.deepEqual(harness.successes, [{ accountId: "acct-1", id: "push-1" }]);
});

test("expired browser endpoints disable themselves after a 410 response", async () => {
  const error = Object.assign(new Error("gone"), { statusCode: 410 });
  const harness = pushHarness({ sendError: error });
  const push = await loadTsModule("lib/web-push.ts", harness.mocks);

  const result = await push.notifyOwnerByWebPush({
    account: { accountId: "acct-1", businessName: "RYCO" },
    event: "voicemail_ready",
    leadId: "lead-2",
    callerPhone: "+12065550456",
  });

  assert.deepEqual(result, { attempted: 1, delivered: 0, disabled: 1 });
  assert.deepEqual(harness.failures, [{
    accountId: "acct-1",
    id: "push-1",
    failureCount: 3,
    disable: true,
  }]);
});

test("missing VAPID configuration suppresses push without querying subscriptions", async () => {
  const harness = pushHarness({ configured: false });
  let listed = false;
  harness.mocks["@/lib/supabase"].listActiveOwnerPushSubscriptions = async () => {
    listed = true;
    return [];
  };
  const push = await loadTsModule("lib/web-push.ts", harness.mocks);

  const result = await push.notifyOwnerByWebPush({
    account: { accountId: "acct-1", businessName: "RYCO" },
    event: "missed_call",
    leadId: "lead-3",
  });

  assert.deepEqual(result, { attempted: 0, delivered: 0, disabled: 0 });
  assert.equal(listed, false);
});

test("push subscription API scopes writes to the authenticated user and account", async () => {
  const upserts = [];
  const disables = [];
  const route = await loadTsModule("app/api/push/subscriptions/route.ts", {
    "@/lib/auth": {
      requireAccountUserJson: async () => ({
        response: null,
        session: { accountId: "acct-session", userId: "user-session" },
      }),
    },
    "@/lib/supabase": {
      upsertOwnerPushSubscription: async (input) => upserts.push(input),
      disableOwnerPushSubscription: async (input) => disables.push(input),
    },
  });
  const subscription = {
    endpoint: "https://push.example.test/device",
    keys: { p256dh: "p".repeat(65), auth: "a".repeat(22) },
  };

  const saved = await route.POST(new Request("https://relay.test/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "test browser" },
    body: JSON.stringify({
      accountId: "acct-attacker",
      userId: "user-attacker",
      subscription,
      missedCallEnabled: true,
      voicemailReadyEnabled: false,
    }),
  }));
  assert.equal(saved.status, 200);
  assert.equal(upserts[0].accountId, "acct-session");
  assert.equal(upserts[0].userId, "user-session");
  assert.equal(upserts[0].voicemailReadyEnabled, false);

  const removed = await route.DELETE(new Request("https://relay.test/api/push/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }));
  assert.equal(removed.status, 200);
  assert.deepEqual(disables, [{
    accountId: "acct-session",
    userId: "user-session",
    endpoint: subscription.endpoint,
  }]);
});

test("push delivery bookkeeping cannot revive a device disabled during an in-flight send", async () => {
  const updates = [];
  const builder = {
    update(value) {
      updates.push(value);
      return this;
    },
    eq() {
      return this;
    },
    error: null,
  };
  const subscriptions = await loadTsModule("lib/supabase/push-subscriptions.ts", {
    "./client": { supabaseAdmin: { from: () => builder } },
    "./tenant": { assertAccountId: (value) => value },
  });

  await subscriptions.markOwnerPushSubscriptionFailed({
    accountId: "acct-1",
    id: "push-1",
    failureCount: 2,
    disable: false,
  });
  await subscriptions.markOwnerPushSubscriptionFailed({
    accountId: "acct-1",
    id: "push-1",
    failureCount: 3,
    disable: true,
  });

  assert.equal("disabled_at" in updates[0], false);
  assert.equal(typeof updates[1].disabled_at, "string");
});

test("PWA assets and push opt-in remain explicit", async () => {
  const [manifest, serviceWorker, settingsControl, schema, migration, requestSecurity] = await Promise.all([
    readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/push-notification-control.tsx", import.meta.url), "utf8"),
    readFile(new URL("../supabase.sql", import.meta.url), "utf8"),
    readFile(new URL("../docs/migrations/2026-08-22-owner-web-push.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/request-security.ts", import.meta.url), "utf8"),
  ]);

  assert.match(manifest, /start_url: "\/leads"/);
  assert.match(manifest, /display: "standalone"/);
  assert.match(serviceWorker, /addEventListener\("push"/);
  assert.match(serviceWorker, /notificationclick/);
  assert.match(settingsControl, /Notification\.requestPermission\(\)/);
  assert.match(settingsControl, /onClick=\{enablePush\}/);
  assert.doesNotMatch(settingsControl, /useEffect\([\s\S]{0,600}Notification\.requestPermission/);
  assert.match(schema, /create table if not exists public\.owner_push_subscriptions/);
  assert.match(migration, /endpoint text not null unique/);
  assert.match(migration, /on public\.owner_push_subscriptions \(endpoint\)/);
  assert.match(migration, /deny_client_access/);
  assert.match(requestSecurity, /"\/api\/push\/"/);
});
