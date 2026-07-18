import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reportsPage = await readFile(new URL("../app/reports/page.tsx", import.meta.url), "utf8");
const reportsData = await readFile(new URL("../lib/supabase/reports.ts", import.meta.url), "utf8");

test("reports page stays focused on owner-useful recovery metrics", () => {
  assert.match(reportsPage, /What Relay recovered/);
  assert.match(reportsPage, /booked from Relay leads/);
  assert.match(reportsPage, /Missed calls captured/);
  assert.match(reportsPage, /Leads that replied/);
  assert.match(reportsPage, /Jobs booked/);
  assert.match(reportsPage, /Booked value/);
  assert.match(reportsPage, /Based on job values you entered/);
});

test("reports page keeps operational noise out of the owner surface", () => {
  assert.doesNotMatch(reportsPage, /getAccountResponseStats/);
  assert.doesNotMatch(reportsPage, /Median response/);
  assert.doesNotMatch(reportsPage, /Urgent calls/);
  assert.doesNotMatch(reportsPage, /Text success rate/);
  assert.doesNotMatch(reportsPage, /Customer replies/);
});

test("reports page exposes a small action strip instead of a raw analytics grid", () => {
  assert.match(reportsPage, /Needs attention/);
  assert.match(reportsPage, /New leads/);
  assert.match(reportsPage, /Failed texts/);
  assert.match(reportsPage, /Booked missing value/);
  assert.match(reportsPage, /inboxCounts\.smsIssues/);
  assert.match(reportsPage, /Nothing needs your attention/);
  assert.match(reportsPage, /activeAttentionItems/);
});

test("reports stats distinguish reply leads and booked jobs missing value", () => {
  assert.match(reportsData, /uniqueReplyLeads/);
  assert.match(reportsData, /bookedMissingValue/);
  assert.match(reportsData, /new Set/);
  assert.match(reportsData, /job_value_cents/);
});

test("reports stats degrade safely when unique reply lead data is unavailable", () => {
  assert.match(reportsData, /isMissingReplyLeadIdError/);
  assert.match(reportsData, /falling back to raw reply count/);
  assert.match(reportsData, /uniqueReplyLeads: replies/);
});
