import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/api/ops/calls/route.ts", import.meta.url), "utf8");

test("account controls preserve real-call and Stripe authority", () => {
  assert.match(source, /pause_onboarding: OPS_ACTIONS\.onboardingPause/);
  assert.match(source, /pause_paid_service: OPS_ACTIONS\.paidServicePause/);
  assert.match(source, /close_account: OPS_ACTIONS\.accountClose/);
  assert.match(source, /reopen_account: OPS_ACTIONS\.accountReopen/);
  assert.match(source, /paid_service_requires_super_admin/);
  assert.match(source, /hasExplicitOpsConfirmation/);
  assert.match(source, /stripeSubscriptionStatus/);
  assert.match(source, /updateAccountOperationalState/);
  assert.doesNotMatch(source, /ready_to_activate|carrier_review|requirements_needed/);
  assert.doesNotMatch(source, /billingStatus:\s*"(?:trialing|active|canceled)"/);
});
