import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/ops/carrier/route.ts", import.meta.url),
  "utf8",
);
const twilio = await readFile(new URL("../lib/twilio.ts", import.meta.url), "utf8");
const page = await readFile(
  new URL("../app/ops/accounts/[id]/page.tsx", import.meta.url),
  "utf8",
);

test("A2P state is synchronized from Twilio rather than selected by an operator", () => {
  assert.match(route, /fetchA2pCampaignStatus/);
  assert.match(route, /external\.campaignStatus/);
  assert.match(route, /normalized === "VERIFIED"/);
  assert.match(route, /a2p_registration_status: next\.a2p/);
  assert.doesNotMatch(route, /form\.get\("action"\)/);
  assert.doesNotMatch(route, /const mapping = \{\s*submitted:/);

  assert.match(twilio, /\.usAppToPerson\(campaignSid\)[\s\S]*\.fetch\(\)/);
  assert.match(page, /Sync status/);
  assert.match(page, /an operator cannot mark A2P approved/);
  assert.doesNotMatch(page, /value="approved"/);
});
