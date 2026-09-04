import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { loadOwnerAlerts } from "./helpers/owner-alerts.mjs";

// Owner alerts from Relay's platform number while the customer's own A2P
// campaign is pending. Owners only; callers are never texted from it.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const ownerAlerts = await loadOwnerAlerts();
const { resolveOwnerAlertSender, ownerTextAlertsAvailable } = ownerAlerts;

async function loadTsModule(path, mocks) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const require = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Missing mock: ${id}`);
  };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

test("sender resolution: account number when texting is on, platform number while pending, nothing otherwise", () => {
  const base = { twilioPhoneNumber: "+12065550199", ownerPhoneNumber: "+12065550101", platformAlertNumber: "+12065550001" };
  assert.deepEqual(resolveOwnerAlertSender({ ...base, smsEnabled: true }), { from: "+12065550199", channel: "account_number" });
  assert.deepEqual(resolveOwnerAlertSender({ ...base, smsEnabled: false }), { from: "+12065550001", channel: "platform_number" });
  assert.equal(resolveOwnerAlertSender({ ...base, smsEnabled: false, platformAlertNumber: "" }), null);
  assert.equal(resolveOwnerAlertSender({ ...base, smsEnabled: false, platformAlertNumber: null }), null);
  assert.equal(resolveOwnerAlertSender({ ...base, smsEnabled: false, platformAlertNumber: undefined }), null);
  // No owner number means nothing to text, whatever senders exist.
  assert.equal(resolveOwnerAlertSender({ ...base, smsEnabled: true, ownerPhoneNumber: null }), null);
  assert.equal(ownerTextAlertsAvailable({ ...base, smsEnabled: false }), true);
  assert.equal(ownerTextAlertsAvailable({ ...base, smsEnabled: false, platformAlertNumber: "" }), false);
});

function twilioHarness({ platformAlertNumber, account }) {
  const state = { creates: [], actions: [] };
  const mocks = {
    twilio: () => ({ messages: { create: async (input) => { state.creates.push(input); return { sid: "SM1", status: "queued" }; } } }),
    "@/lib/env": { env: { twilioAccountSid: "AC", twilioAuthToken: "t", ownerAlertFromNumber: platformAlertNumber, appBaseUrl: "https://relay.test" } },
    "@/lib/owner-alerts": ownerAlerts,
    "@/lib/email": { notifyAdminOperationalIssue: async () => {} },
    "@/lib/supabase": { logWebhookEvent: async () => {} },
    "@/lib/supabase/provider-actions": {
      recordProviderAction: async (input) => { state.actions.push(input); return { id: "evt" }; },
      claimProviderActionRetry: async () => true,
    },
    "@/lib/supabase/accounts": {},
    "@/lib/twilio-webhook-urls": { twilioWebhookUrlCandidates: () => [] },
  };
  return { state, mocks, account };
}

const pendingAccount = {
  accountId: "acct-a",
  smsEnabled: false,
  ownerPhoneNumber: "+12065550101",
  twilioPhoneNumber: "+12065550199",
};

test("sendOwnerSms texts the owner from the platform number while the account's campaign is pending", async () => {
  const { state, mocks } = twilioHarness({ platformAlertNumber: "+12065550001", account: pendingAccount });
  const { sendOwnerSms } = await loadTsModule("lib/twilio.ts", mocks);
  const sent = await sendOwnerSms({ account: pendingAccount, body: "Relay NW: missed call", context: "test", actionKey: "owner_sms:test:1" });
  assert.equal(sent, true);
  assert.deepEqual(state.creates, [{ to: "+12065550101", from: "+12065550001", body: "Relay NW: missed call" }]);
  const accepted = state.actions.find((action) => action.internalStatus === "accepted");
  assert.equal(accepted.providerStatus, "queued:platform_number");
});

test("sendOwnerSms stays a quiet no-op when neither sender exists, and never invents a from number", async () => {
  const { state, mocks } = twilioHarness({ platformAlertNumber: undefined, account: pendingAccount });
  const { sendOwnerSms } = await loadTsModule("lib/twilio.ts", mocks);
  const sent = await sendOwnerSms({ account: pendingAccount, body: "x", context: "test", actionKey: "owner_sms:test:2" });
  assert.equal(sent, false);
  assert.equal(state.creates.length, 0);
  const suppressed = state.actions.find((action) => action.internalStatus === "suppressed");
  assert.equal(suppressed.expectedSuppression, true);
  assert.match(suppressed.customerExplanation, /Email and browser alerts still work/);
});

test("sendOwnerSms prefers the account's own number once texting is on", async () => {
  const account = { ...pendingAccount, smsEnabled: true };
  const { state, mocks } = twilioHarness({ platformAlertNumber: "+12065550001", account });
  const { sendOwnerSms } = await loadTsModule("lib/twilio.ts", mocks);
  await sendOwnerSms({ account, body: "x", context: "test", actionKey: "owner_sms:test:3" });
  assert.equal(state.creates[0].from, "+12065550199");
});

test("the platform alert number can only ever reach the owner", async () => {
  const twilioTs = await read("lib/twilio.ts");
  const missedCallTs = await read("lib/missed-call.ts");
  const replyRoute = await read("app/api/leads/[id]/reply/route.ts");
  // Every send that resolves a sender goes to account.ownerPhoneNumber.
  assert.match(twilioTs, /to: account\.ownerPhoneNumber,\s*from: sender\.from,/);
  assert.match(missedCallTs, /to: account\.ownerPhoneNumber,\s*from: sender\.from,/);
  // Caller-facing texts never reference the platform number.
  const callerSend = missedCallTs.slice(missedCallTs.indexOf("export async function handleMissedCall"));
  assert.doesNotMatch(callerSend, /ownerAlertFromNumber|resolveOwnerAlertSender/);
  assert.doesNotMatch(replyRoute, /ownerAlertFromNumber|owner-alerts/);
  // Only the two owner paths consult the platform number.
  const uses = (missedCallTs.match(/ownerAlertFromNumber/g) ?? []).length + (twilioTs.match(/ownerAlertFromNumber/g) ?? []).length;
  assert.equal(uses, 2);
});

test("missed call with texting off now texts the owner with a deep link and the caller's number", async () => {
  const missedCallTs = await read("lib/missed-call.ts");
  const disabledBranch = missedCallTs.slice(
    missedCallTs.indexOf("if (!account.smsEnabled) {"),
    missedCallTs.indexOf("if (!account.smsEnabled) {") + 2200,
  );
  assert.match(disabledBranch, /notifyOwnerNewLeadBySms\(\{\s*account,\s*callerPhone,\s*smsStatus: "skipped_disabled",\s*correlationId,\s*leadId: leadResult\.leadId,/);
  assert.match(missedCallTs, /No auto-text went out \(texting is not on yet\), so call them back: \$\{input\.callerPhone\}\. Lead: \$\{inboxUrl\}/);
  assert.match(missedCallTs, /input\.leadId \? `\$\{env\.appBaseUrl\}\/leads\/\$\{input\.leadId\}` : `\$\{env\.appBaseUrl\}\/leads`/);
  // Owner preference to turn text alerts off is still honoured first.
  assert.match(missedCallTs, /if \(account\.notificationPreferences\?\.missedCall\.sms === false\) \{[\s\S]*?return;\s*\}[\s\S]*?const sender = resolveOwnerAlertSender/);
});

test("voicemail alerts deep-link the lead and contain no em dashes", async () => {
  const voicemailAi = await read("lib/voicemail-ai.ts");
  assert.match(voicemailAi, /Lead: \$\{env\.appBaseUrl\}\/leads\/\$\{leadId\}`/);
  const alerts = voicemailAi.slice(voicemailAi.indexOf("Relay NW URGENT"), voicemailAi.indexOf("Relay NW URGENT") + 500);
  assert.doesNotMatch(alerts, /—/);
});

test("settings reports text alerts as available whenever Relay can text the owner", async () => {
  const settings = await read("app/settings/page.tsx");
  const preferences = await read("app/settings/notification-preferences.tsx");
  assert.match(settings, /textAlertsActive=\{ownerTextAlertsAvailable\(\{\s*smsEnabled: account\.smsEnabled && a2pStatus === "approved",/);
  assert.match(settings, /platformAlertNumber: env\.ownerAlertFromNumber,/);
  assert.match(preferences, /not available yet/);
  assert.doesNotMatch(preferences, /waiting for texting/);
  const envExample = await read(".env.example");
  assert.match(envExample, /OWNER_ALERT_FROM_NUMBER=""/);
});
