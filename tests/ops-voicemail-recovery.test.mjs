import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/ops/voicemail-recovery/route.ts", import.meta.url),
  "utf8",
);
const voicemails = await readFile(
  new URL("../lib/supabase/voicemails.ts", import.meta.url),
  "utf8",
);

test("manual voicemail recovery is operator-authorized and account scoped", () => {
  assert.match(route, /requirePlatformOperatorAction\(OPS_ACTIONS\.voicemailRecovery\)/);
  assert.match(route, /listLeadsNeedingSummaryRetry\(25, account\.accountId\)/);
  assert.match(route, /transcribeLeadVoicemail\(lead\.id, account\.accountId\)/);
  assert.match(route, /recordAccountAuditEvents/);
  assert.match(route, /recordPlatformAuditEvent/);
  assert.match(voicemails, /assertAccountId\(inputAccountId, "listLeadsNeedingSummaryRetry"\)/);
  assert.match(voicemails, /query = query\.eq\([\s\S]{0,100}"account_id"/);
});
