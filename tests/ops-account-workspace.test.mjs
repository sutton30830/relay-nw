import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(
  new URL("../app/ops/accounts/[id]/page.tsx", import.meta.url),
  "utf8",
);
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("account workspace has one command center and independent domain status", () => {
  assert.equal((page.match(/aria-label="Account command center"/g) ?? []).length, 1);
  assert.equal((page.match(/aria-label="Primary operator action"/g) ?? []).length, 1);
  assert.match(page, /<dt>Calls<\/dt>/);
  assert.match(page, /<dt>Texting<\/dt>/);
  assert.match(page, /<dt>Billing<\/dt>/);
  assert.match(page, /<dt>Blocked by<\/dt>/);
  assert.match(page, /\{opsState\.nextAction\.label\}/);
  assert.match(page, /\{opsState\.nextAction\.detail\}/);
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
  assert.match(page, /<strong>Customer details<\/strong>/);
  assert.match(page, /<details className="panel setup-panel ops-diagnostics"/);
  assert.match(page, /operator\.role !== "support"/);
  assert.match(page, /operator\.role === "super_admin"/);
  assert.match(page, /Super-admin commercial exceptions/);
  assert.match(page, /Open payment in Stripe/);
  assert.doesNotMatch(page, /api\/ops\/billing\/refund/);
});

test("primary billing actions retain secure server-side paths", () => {
  assert.match(page, /action="\/api\/ops\/billing\/activate"/);
  assert.match(page, /action="\/api\/ops\/kickoff"/);
  assert.match(page, /action="\/api\/ops\/billing\/reconcile"/);
  assert.match(page, /action="\/api\/ops\/carrier"/);
  assert.match(page, /action="\/api\/ops\/twilio\/assign"/);
  assert.match(page, /action="\/api\/ops\/blocker"/);
  assert.match(page, /A signed real call controls call readiness/);
  assert.match(page, /an operator cannot mark A2P approved/);
  assert.match(page, /Stripe-owned money state/);
});

test("workspace adapts from desktop to phone layouts", () => {
  assert.match(css, /\.ops-workspace-command\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /\.ops-workspace-grid\s*\{[\s\S]*grid-template-columns:/);
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.ops-workspace-command,[\s\S]*\.ops-workspace-grid\s*\{\s*grid-template-columns: 1fr;/,
  );
  assert.match(
    css,
    /@media \(max-width: 430px\)[\s\S]*\.ops-workspace-status,[\s\S]*\.ops-workspace-facts\s*\{\s*grid-template-columns: 1fr;/,
  );
});
