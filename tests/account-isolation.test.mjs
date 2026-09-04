import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function compact(value) {
  return value.replace(/\s+/g, " ");
}

const files = {
  leadsPage: await source("app/leads/page.tsx"),
  setupPage: await source("app/setup/page.tsx"),
  onboardingReadiness: await source("lib/onboarding-readiness.ts"),
  opsPage: await source("app/ops/page.tsx"),
  opsAccountPage: await source("app/ops/accounts/[id]/page.tsx"),
  leadApi: await source("app/api/leads/[id]/route.ts"),
  transcribeApi: await source("app/api/leads/[id]/transcribe/route.ts"),
  recordingApi: await source("app/api/recordings/[recordingSid]/route.ts"),
  voiceWebhook: await source("app/api/twilio/voice/route.ts"),
  dialStatusWebhook: await source("app/api/twilio/dial-status/route.ts"),
  recordingWebhook: await source("app/api/twilio/recording/route.ts"),
  smsWebhook: await source("app/api/twilio/sms/route.ts"),
  smsStatusWebhook: await source("app/api/twilio/sms-status/route.ts"),
  twilioIngress: await source("lib/telephony/providers/twilio-webhooks.ts"),
  webhookServices: await source("lib/telephony/webhook-services.ts"),
  unresolvedHandler: await source("lib/twilio/unresolved-account.ts"),
  accountStore: await source("lib/supabase/accounts.ts"),
  leadsStore: await source("lib/supabase/leads.ts"),
  messagesStore: await source("lib/supabase/messages.ts"),
  callsStore: await source("lib/supabase/calls.ts"),
  webhooksStore: await source("lib/supabase/webhooks.ts"),
  voicemailsStore: await source("lib/supabase/voicemails.ts"),
  tenantStore: await source("lib/supabase/tenant.ts"),
};

test("authenticated lead, ops, recording, and transcription routes use session account scope", () => {
  assert.match(files.leadsPage, /const session = await requireAccountUser\(\)/);
  assert.match(files.leadsPage, /const \{ account, accountId, membershipCount \} = session/);
  assert.match(files.leadsPage, /getLeadInboxPageForAccount\(accountId/);

  assert.match(files.setupPage, /const session = await requireAccountUser\(\)/);
  assert.match(files.setupPage, /const \{ account, accountId, membershipCount \} = session/);
  assert.match(files.setupPage, /loadAccountOnboardingReadiness\(accountId\)/);
  assert.match(files.onboardingReadiness, /getAccountTechnicalSetupStatus\(accountId\)/);
  assert.match(files.onboardingReadiness, /getA2pRegistrationStatus\(accountId\)/);
  assert.match(files.onboardingReadiness, /getAccountOnboardingEvidence\(accountId\)/);

  // Ops pages authorize via the platform-operator gate and look accounts up by
  // explicit slug — never by the operator's own session account.
  assert.match(files.opsPage, /const operator = await requirePlatformOperator\(\)/);
  assert.match(files.opsAccountPage, /await requirePlatformOperator\(\)/);
  assert.match(files.opsAccountPage, /getOpsAccountBySlug\(id\)/);
  assert.match(files.opsAccountPage, /getRecentWebhookEventsForAccount\(billing\.accountId,\s*25\)/);

  assert.match(files.leadApi, /const auth = await requireWriteAccessJson\(\)/);
  assert.match(compact(files.leadApi), /updateLead\(\{ accountId: auth\.session\.accountId, id, \.\.\.update \}\)/);
  assert.match(compact(files.leadApi), /deleteLead\(id, auth\.session\.accountId\)/);

  assert.match(files.recordingApi, /const auth = await requireAccountUserJson\(\)/);
  assert.match(
    compact(files.recordingApi),
    /getLeadRecordingForPlayback\( providerRecordingId, auth\.session\.accountId,? \)/,
  );

  assert.match(files.transcribeApi, /const auth = await requireWriteAccessJson\(\)/);
  assert.match(files.transcribeApi, /transcribeLeadVoicemail\(id, auth\.session\.accountId\)/);
});

test("Twilio webhooks resolve account context before writing tenant data", () => {
  for (const route of [
    files.voiceWebhook,
    files.dialStatusWebhook,
    files.recordingWebhook,
    files.smsWebhook,
    files.smsStatusWebhook,
  ]) {
    assert.match(route, /@\/lib\/telephony\/providers\/twilio-webhooks/);
    assert.doesNotMatch(route, /payload\.(?:CallSid|MessageSid|RecordingSid|From|To|Body)/);
  }

  assert.match(files.webhookServices, /resolveAccountByProviderCallId\(event\.callId\?\.value\)/);
  assert.match(files.webhookServices, /resolveAccountByProviderMessageId\(event\.messageId\?\.value\)/);
  assert.match(files.webhookServices, /resolveAccountByRelayPhoneNumber\(event\.to\)/);
  assert.match(files.webhookServices, /resolveConsistentAccountEvidence\(\[/);
  assert.match(files.twilioIngress, /accountResolution\.status === "unresolved"/);
  assert.match(files.twilioIngress, /handleUnresolvedTwilioAccount\(\{/);
  assert.match(files.webhookServices, /accountId: input\.account\.accountId/);
  assert.match(files.webhookServices, /transcribeLeadVoicemail\(input\.leadId, input\.account\.accountId\)/);
});

test("unresolved Twilio account handling alerts admin and avoids tenant writes", () => {
  assert.match(files.accountStore, /export type AccountResolution/);
  assert.match(files.accountStore, /status: "unresolved"/);
  assert.match(files.accountStore, /twilio_number_not_registered/);
  assert.match(files.accountStore, /call_sid_not_registered/);
  assert.match(files.accountStore, /message_sid_not_registered/);

  assert.match(files.unresolvedHandler, /notifyAdminOperationalIssue\(\{/);
  assert.match(files.unresolvedHandler, /logWebhookEvent\(\{/);
  assert.match(files.unresolvedHandler, /accountId: null/);
  assert.match(files.unresolvedHandler, /return twimlResponse\(responseBody\)/);
  assert.doesNotMatch(files.unresolvedHandler, /createLead|upsertCall|createMessageIfNew|updateLead/);
});

test("lead queries and mutations filter by account_id when an account is supplied", () => {
  assert.match(files.tenantStore, /export function assertAccountId/);
  assert.match(files.leadsStore, /query = query\.eq\("account_id", accountId\)/);
  assert.match(files.leadsStore, /rpc\("search_lead_inbox_v2"/);
  assert.match(files.leadsStore, /p_account: accountId[\s\S]*p_limit: limit, p_offset: offset/);
  assert.match(files.leadsStore, /DEFAULT_LEADS_PAGE_LIMIT = 50/);
  assert.doesNotMatch(files.leadsStore, /legacyQuery/);
  assert.match(files.leadsStore, /\.eq\("id", input\.id\)\s*\.eq\("account_id", accountId\)/);
  assert.match(files.leadsStore, /\.eq\("id", id\)\s*\.eq\("account_id", accountId\)/);
  assert.doesNotMatch(files.leadsStore, /\.match\([^)]*account_id[^)]*:\s*\{\}/);
  assert.doesNotMatch(files.leadsStore, /export async function getLeads\(/);
});

test("recordings, messages, calls, and webhook debug reads are account scoped", () => {
  assert.match(files.voicemailsStore, /\.eq\("recording_sid", providerRecordingId\)\s*\.eq\("account_id", accountId\)/);
  assert.match(files.voicemailsStore, /\.eq\("id", id\)\s*\.eq\("account_id", accountId\)/);
  assert.match(files.voicemailsStore, /\.eq\("call_sid", providerCallId\)\s*\.eq\("account_id", accountId\)/);

  assert.match(files.messagesStore, /\.eq\("account_id", accountId\)\s*\.eq\("twilio_message_sid", providerMessageId\)/);
  assert.match(files.messagesStore, /upsert\(\{ phone, account_id: accountId \}, \{ onConflict: "account_id,phone" \}\)/);
  assert.match(files.messagesStore, /account_id: accountId/);

  assert.match(files.callsStore, /onConflict: "account_id,call_sid"/);
  assert.match(files.callsStore, /\.eq\("account_id", accountId\)\s*\.eq\("call_sid", providerCallId\)/);

  assert.match(files.webhooksStore, /\.eq\("account_id", accountId\)\s*\.limit\(limit\)/);
  assert.match(files.webhooksStore, /account_id: input\.accountId \?\? null/);
  assert.doesNotMatch(files.webhooksStore, /export async function getRecentWebhookEvents\(/);

  for (const store of [
    files.leadsStore,
    files.messagesStore,
    files.callsStore,
    files.webhooksStore,
    files.voicemailsStore,
  ]) {
    assert.doesNotMatch(store, /\.match\([^)]*\?\s*\{\s*account_id:/);
  }
});
