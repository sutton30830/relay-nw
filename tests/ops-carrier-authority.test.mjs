import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/ops/carrier/route.ts", import.meta.url),
  "utf8",
);
const twilio = await readFile(new URL("../lib/twilio.ts", import.meta.url), "utf8");
const a2pSync = await readFile(new URL("../lib/a2p-sync.ts", import.meta.url), "utf8");
const page = await readFile(
  new URL("../app/ops/accounts/[id]/page.tsx", import.meta.url),
  "utf8",
);

test("A2P state is synchronized from Twilio rather than selected by an operator", () => {
  assert.match(route, /fetchA2pRegistrationEvidence/);
  assert.match(route, /external\.campaignStatus/);
  assert.match(route, /deriveA2pSyncDecision\(external\)/);
  assert.match(a2pSync, /campaignStatus !== "VERIFIED"/);
  assert.match(a2pSync, /serviceA2pRegistered/);
  assert.match(a2pSync, /relayNumberInSenderPool/);
  assert.match(a2pSync, /relayNumberSmsCapable/);
  assert.match(route, /a2p_registration_status: next\.a2p/);
  assert.doesNotMatch(route, /form\.get\("action"\)/);
  assert.doesNotMatch(route, /const mapping = \{\s*submitted:/);

  assert.match(twilio, /\.usAppToPerson\(campaignSid\)[\s\S]*\.fetch\(\)/);
  assert.match(twilio, /serviceContext\.phoneNumbers\.list/);
  assert.match(page, /Sync status/);
  assert.match(page, /an operator cannot mark A2P approved/);
  assert.doesNotMatch(page, /value="approved"/);
});
