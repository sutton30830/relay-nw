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
  unresolvedHandler: await source("lib/twilio/unresolved-account.ts"),
  accountStore: await source("lib/supabase/accounts.ts"),
  leadsStore: await source("lib/supabase/leads.ts"),
  messagesStore: await source("lib/supabase/messages.ts"),
  callsStore: await source("lib/supabase/calls.ts"),
  webhooksStore: await source("lib/supabase/webhooks.ts"),
  voicemailsStore: await source("lib/supabase/voicemails.ts"),
  healthChecksStore: await source("lib/supabase/health-checks.ts"),
  tenantStore: await source("lib/supabase/tenant.ts"),
};

test("authenticated lead, ops, recording, and transcription routes use session account scope", () => {
  assert.match(files.leadsPage, /const session = await requireAccountUser\(\)/);
  assert.match(files.leadsPage, /const \{ account, accountId, membershipCount \} = session/);
  assert.match(files.leadsPage, /getLeadInboxPageForAccount\(accountId/);
  assert.doesNotMatch(files.leadsPage, /getForwardingHealthSummary\(accountId\)/);

  assert.match(files.setupPage, /const session = await requireAccountUser\(\)/);
  assert.match(files.setupPage, /const \{ account, accountId, membershipCount \} = session/);
  assert.match(files.setupPage, /getAccountTechnicalSetupStatus\(accountId\)/);
  assert.doesNotMatch(files.setupPage, /getForwardingHealthSummary\(accountId\)/);
  assert.match(files.setupPage, /getA2pRegistrationStatus\(accountId\)/);

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
  assert.match(files.recordingApi, /getLeadRecordingForPlayback\(recordingSid, auth\.session\.accountId\)/);

  assert.match(files.transcribeApi, /const auth = await requireWriteAccessJson\(\)/);
  assert.match(files.transcribeApi, /transcribeLeadVoicemail\(id, auth\.session\.accountId\)/);
});

test("Twilio webhooks resolve account context before writing tenant data", () => {
  assert.match(files.voiceWebhook, /resolveAccountByTwilioNumber\(payload\.To\)/);
  assert.match(files.voiceWebhook, /accountResolution\.status === "unresolved"/);
  assert.match(files.voiceWebhook, /handleUnresolvedTwilioAccount\(\{/);
  assert.match(files.voiceWebhook, /accountId: input\.account\.accountId/);
  assert.match(files.voiceWebhook, /account: input\.account/);

  assert.match(files.dialStatusWebhook, /resolveAccountByCallSid\(callSid\)/);
  assert.match(files.dialStatusWebhook, /accountResolution\.status === "unresolved"/);
  assert.match(files.dialStatusWebhook, /handleUnresolvedTwilioAccount\(\{/);
  assert.match(files.dialStatusWebhook, /accountId: input\.account\.accountId/);
  assert.match(files.dialStatusWebhook, /account: input\.account/);

  assert.match(files.recordingWebhook, /resolveAccountByCallSid\(recording\.callSid\)/);
  assert.match(files.recordingWebhook, /accountResolution\.status === "unresolved"/);
  assert.match(files.recordingWebhook, /handleUnresolvedTwilioAccount\(\{/);
  assert.match(files.recordingWebhook, /accountId: account\.accountId/);
  assert.match(files.recordingWebhook, /transcribeLeadVoicemail\(result\.leadId!, account\.accountId\)/);

  assert.match(files.smsWebhook, /resolveAccountByTwilioNumber\(message\.to \|\| payload\.To\)/);
  assert.match(files.smsWebhook, /accountResolution\.status === "unresolved"/);
  assert.match(files.smsWebhook, /handleUnresolvedTwilioAccount\(\{/);
  assert.match(files.smsWebhook, /accountId: account\.accountId/);

  assert.match(files.smsStatusWebhook, /resolveAccountByMessageSid\(status\.messageSid\)/);
  assert.match(files.smsStatusWebhook, /accountResolution\.status === "unresolved"/);
  assert.match(files.smsStatusWebhook, /handleUnresolvedTwilioAccount\(\{/);
  assert.match(files.smsStatusWebhook, /accountId: account\.accountId/);
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
  assert.match(files.leadsStore, /\.range\(offset, offset \+ limit - 1\)/);
  assert.match(files.leadsStore, /DEFAULT_LEADS_PAGE_LIMIT = 50/);
  assert.match(files.leadsStore, /legacyQuery = legacyQuery\.eq\("account_id", accountId\)/);
  assert.match(files.leadsStore, /\.eq\("id", input\.id\)\s*\.eq\("account_id", accountId\)/);
  assert.match(files.leadsStore, /\.eq\("id", id\)\s*\.eq\("account_id", accountId\)/);
  assert.doesNotMatch(files.leadsStore, /\.match\([^)]*account_id[^)]*:\s*\{\}/);
  assert.doesNotMatch(files.leadsStore, /export async function getLeads\(/);
});

test("recordings, messages, calls, health checks, and webhook debug reads are account scoped", () => {
  assert.match(files.voicemailsStore, /\.eq\("recording_sid", recordingSid\)\s*\.eq\("account_id", accountId\)/);
  assert.match(files.voicemailsStore, /\.eq\("id", id\)\s*\.eq\("account_id", accountId\)/);
  assert.match(files.voicemailsStore, /\.eq\("call_sid", input\.callSid\)\s*\.eq\("account_id", accountId\)/);

  assert.match(files.messagesStore, /\.eq\("account_id", accountId\)\s*\.eq\("twilio_message_sid", input\.twilioMessageSid\)/);
  assert.match(files.messagesStore, /upsert\(\{ phone, account_id: accountId \}, \{ onConflict: "account_id,phone" \}\)/);
  assert.match(files.messagesStore, /account_id: accountId/);

  assert.match(files.callsStore, /onConflict: "account_id,call_sid"/);
  assert.match(files.callsStore, /\.eq\("account_id", accountId\)\s*\.eq\("call_sid", input\.callSid\)/);

  assert.match(files.webhooksStore, /\.eq\("account_id", accountId\)\s*\.limit\(limit\)/);
  assert.match(files.webhooksStore, /account_id: input\.accountId \?\? null/);
  assert.doesNotMatch(files.webhooksStore, /export async function getRecentWebhookEvents\(/);

  assert.match(files.healthChecksStore, /\.eq\("account_id", accountId\)\s*\.eq\("status", "pending"\)/);
  assert.match(files.healthChecksStore, /\.eq\("id", input\.id\)\s*\.eq\("account_id", accountId\)/);

  for (const store of [
    files.leadsStore,
    files.messagesStore,
    files.callsStore,
    files.webhooksStore,
    files.voicemailsStore,
    files.healthChecksStore,
  ]) {
    assert.doesNotMatch(store, /\.match\([^)]*\?\s*\{\s*account_id:/);
  }
});
