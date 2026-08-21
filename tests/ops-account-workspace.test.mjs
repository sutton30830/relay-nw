import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(
  new URL("../app/ops/accounts/[id]/page.tsx", import.meta.url),
  "utf8",
);
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("account workspace has one compact status strip and one primary action", () => {
  assert.equal((page.match(/aria-label="Primary operator action"/g) ?? []).length, 1);
  assert.equal((page.match(/aria-label="Independent account statuses"/g) ?? []).length, 1);
  assert.match(page, /<dt>Calls<\/dt>/);
  assert.match(page, /<dt>Texting<\/dt>/);
  assert.match(page, /<dt>Billing<\/dt>/);
  assert.match(page, /<dt>Blocked by<\/dt>/);
  assert.match(page, /<h2>\{primaryAction\.label\}<\/h2>/);
  assert.match(page, /<p>\{primaryAction\.detail\}<\/p>/);
  assert.equal((page.match(/aria-label="Repeatable onboarding workflow"/g) ?? []).length, 0);
  assert.doesNotMatch(page, /onboarding\.readiness\.checks\.map/);
  assert.doesNotMatch(page, /complete\s*<\/span>/);
});

test("the working surface is one setup card and one billing card", () => {
  assert.equal((page.match(/id="setup" aria-label="Setup"/g) ?? []).length, 1);
  assert.equal((page.match(/id="billing" aria-label="Billing"/g) ?? []).length, 1);
  assert.doesNotMatch(page, /aria-label="Kickoff fee"/);
  assert.doesNotMatch(page, /aria-label="Monthly billing"/);
  assert.doesNotMatch(page, /aria-label="Operations blocker"/);
  assert.doesNotMatch(page, /aria-label="Relay number assignment"/);
  assert.doesNotMatch(page, /Registration worksheet/);
});

test("infrequent details and diagnostics are collapsed without weakening controls", () => {
  assert.match(page, /<details className="panel setup-panel ops-customer-details"/);
  assert.match(page, /<strong>Call setup<\/strong>/);
  assert.match(page, /Optional and advanced settings/);
  assert.match(page, /name="business_hours_summary"/);
  assert.match(page, /name="coverage_expectations"/);
  assert.match(page, /Missed-call coverage expectations/);
  assert.match(page, /<details className="panel setup-panel ops-diagnostics"/);
  assert.match(page, /operator\.role !== "support"/);
  assert.match(page, /operator\.role === "super_admin"/);
  assert.match(page, /Super-admin commercial exceptions/);
  assert.match(page, /Open payment in Stripe/);
  assert.doesNotMatch(page, /api\/ops\/billing\/refund/);
});

test("focused operational rows retain secure server-side paths and authority", () => {
  assert.match(page, /action="\/api\/ops\/billing\/activate"/);
  assert.match(page, /action="\/api\/ops\/kickoff"/);
  assert.match(page, /action="\/api\/ops\/billing\/reconcile"/);
  assert.match(page, /action="\/api\/ops\/carrier"/);
  assert.match(page, /action="\/api\/ops\/twilio\/assign"/);
  assert.match(page, /action="\/api\/ops\/blocker"/);
  assert.match(page, /action="\/api\/ops\/voicemail-recovery"/);
  assert.match(page, /action="\/api\/email-test\/start"/);
  assert.match(page, /Send owner email test/);
  assert.match(page, /Recover summaries/);
  assert.match(page, /verified by a real missed call/);
  assert.match(page, /an operator cannot mark A2P approved/);
  assert.match(page, /Relay status:/);
  assert.match(page, /Twilio profile:/);
  assert.match(page, /Last Twilio sync:/);
  assert.match(page, /managed in Stripe/);
  assert.match(page, /id="calls" open=\{callsControlOpen\}/);
  assert.match(page, /id="texting" open=\{textingControlOpen\}/);
  assert.match(page, /id="blocker" open=\{blockerControlOpen\}/);
  assert.doesNotMatch(page, /Stripe-owned money state|These move independently|Four facts, no invented lifecycle/);
});

test("workspace adapts from desktop to phone layouts", () => {
  assert.match(css, /\.ops-workspace-layout\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /\.ops-task-row > summary\s*\{[\s\S]*grid-template-columns:/);
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.ops-workspace-layout\s*\{\s*grid-template-columns: 1fr;/,
  );
  assert.match(
    css,
    /@media \(max-width: 430px\)[\s\S]*\.ops-workspace-status\s*\{\s*grid-template-columns: 1fr;/,
  );
});
