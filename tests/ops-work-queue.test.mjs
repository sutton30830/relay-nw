import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const queue = await readFile(
  new URL("../app/ops/_components/ops-account-directory.tsx", import.meta.url),
  "utf8",
);
const page = await readFile(new URL("../app/ops/page.tsx", import.meta.url), "utf8");
const header = await readFile(
  new URL("../app/leads/_components/app-header.tsx", import.meta.url),
  "utf8",
);
const accounts = await readFile(new URL("../lib/supabase/accounts.ts", import.meta.url), "utf8");
const customersRedirect = await readFile(
  new URL("../app/ops/customers/page.tsx", import.meta.url),
  "utf8",
);
const requestsRedirect = await readFile(
  new URL("../app/ops/setup-requests/page.tsx", import.meta.url),
  "utf8",
);
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("Operations is one derived work queue with new requests at the top of onboarding", () => {
  assert.match(page, /listSetupRequests\("new"\)/);
  assert.match(queue, /Needs attention/);
  assert.match(queue, /Onboarding/);
  assert.match(queue, /Running/);
  assert.match(queue, /Paused or closed/);
  assert.match(queue, /New setup request/);
  assert.match(queue, /Accept and invite/);
  assert.match(queue, /group\.key === "onboarding"/);
  assert.match(queue, /\{children\}[\s\S]*ops-queue-grid/);
});

test("customer cards and search stay concise while matching all operational lookup fields", () => {
  for (const field of [
    "businessName",
    "ownerName",
    "ownerEmail",
    "accountSlug",
    "relayNumber",
    "publicBusinessNumber",
  ]) {
    assert.match(queue, new RegExp(`account\\.${field}`));
  }
  assert.match(queue, /Calls/);
  assert.match(queue, /Texting/);
  assert.match(queue, /Billing/);
  assert.match(queue, /Blocked by/);
  assert.match(queue, /Next action/);
  assert.match(queue, /Open account/);
  assert.doesNotMatch(queue, /Diagnostics/);
  assert.doesNotMatch(queue, /stage|Review account/i);
  assert.doesNotMatch(queue, /stripe_|twilio_/i);
  assert.match(accounts, /account_phone_numbers\(phone_number, is_primary\)/);
  assert.match(accounts, /public_business_number/);
});

test("navigation exposes Work queue, Accounts, and Team while retired URLs redirect", () => {
  assert.match(header, /label: "Work queue"/);
  assert.match(header, /label: "Accounts"/);
  assert.match(header, /label: "Team"/);
  assert.doesNotMatch(header, /label: "Customers"/);
  assert.doesNotMatch(header, /label: "Requests"/);
  assert.match(customersRedirect, /redirect\(`\/ops\/accounts/);
  assert.match(requestsRedirect, /redirect\(`\/ops\$\{query\}#new-requests/);
});

test("Work queue cards adapt from a multi-column desktop grid to touch-friendly mobile controls", () => {
  assert.match(css, /\.ops-queue-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fit, minmax\(280px, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.ops-new-request[\s\S]*flex-direction:\s*column/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.ops-queue-card > \.btn\s*\{\s*width:\s*100%/);
});
