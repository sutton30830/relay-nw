import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Phase 1 customer billing copy: money timing and Stripe ownership must be
// explicit without exposing internal lifecycle machinery.

const settings = await readFile(
  new URL("../app/settings/page.tsx", import.meta.url),
  "utf8",
);
const setup = await readFile(
  new URL("../app/setup/page.tsx", import.meta.url),
  "utf8",
);

test("customer billing is transparent and Stripe-hosted", () => {
  assert.match(settings, /Current plan: \$99\/month/);
  assert.match(settings, /charge \$99 now, then \$99 monthly until canceled/);
  assert.match(settings, /payment methods, invoices, billing details, and cancellation/);
  assert.match(settings, />\s*Manage billing\s*</);
  assert.match(settings, /Contact Relay about billing or a refund/);
  assert.match(settings, /Refund status updates here only after Stripe confirms it/);
  assert.match(settings, /failed payment does not immediately interrupt missed-call capture/);
  assert.match(settings, /Monthly trial waits for text-back/);
  assert.match(settings, /trial waits for automatic text-back activation/);
  assert.match(settings, /Add payment method/);
  assert.match(settings, /Payment method saved\. Nothing was charged/);
  assert.match(settings, /One time\. Securely paid through Stripe/);
  assert.match(settings, /day trial starts after automatic text-back is on/);
  assert.doesNotMatch(settings, /function SetupFeeAction/);
  assert.equal((settings.match(/action="\/api\/billing\/setup-fee"/g) ?? []).length, 1);
});

test("A2P registration is not a customer questionnaire", () => {
  for (const source of [setup, settings]) {
    assert.doesNotMatch(source, /registration_id|representative_mobile|opt_in_flow|sample_messages/);
    assert.doesNotMatch(source, /carrier-profile/);
  }

  assert.match(settings, /Relay is enabling texting/);
  assert.match(settings, /Texting is available/);
});

test("billing remains separate from technical setup", () => {
  assert.doesNotMatch(setup, /Stripe|setup fee|\$99|Manage billing/i);
  assert.match(setup, /getAccountTechnicalSetupStatus/);
  assert.match(setup, /first real missed call/i);
});

test("customer setup shows independent call and texting facts with one relevant action", () => {
  assert.match(setup, /customer-setup-overview/);
  assert.match(setup, /Automatic text-back/);
  assert.match(setup, /Enable text-back/);
  assert.match(setup, /\/settings#texting/);
  assert.doesNotMatch(setup, /Stripe-owned|carrier review|billing lifecycle/i);
});
