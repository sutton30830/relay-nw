import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reportsPage = await readFile(new URL("../app/reports/page.tsx", import.meta.url), "utf8");
const reportsData = await readFile(new URL("../lib/supabase/reports.ts", import.meta.url), "utf8");
const globalsCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("reports page stays focused on owner-useful recovery metrics", () => {
  assert.match(reportsPage, /What Relay recovered/);
  assert.match(reportsPage, /Live inbox/);
  assert.match(reportsPage, /Current inbox/);
  assert.match(reportsPage, /Leads in inbox/);
  assert.match(reportsPage, /Current non-trash lead cards in your inbox/);
  assert.doesNotMatch(reportsPage, /Missed calls captured/);
  assert.doesNotMatch(reportsPage, /Leads that replied/);
  assert.match(reportsPage, /Jobs booked/);
  assert.match(reportsPage, /Booked value/);
  assert.match(reportsPage, /Based on job values you entered/);
  assert.match(reportsPage, /typicalJobValueCents: account\.typicalJobValueCents/);
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
  assert.match(reportsPage, /bookedMissingValue = Math\.max\(0, inboxCounts\.booked - inboxCounts\.bookedWithValue\)/);
  assert.match(reportsPage, /Nothing needs your attention/);
  assert.match(reportsPage, /activeAttentionItems/);
});

test("reports presentation uses the statement ledger system", () => {
  assert.match(reportsPage, /className="ledger"/);
  assert.match(reportsPage, /className="report-footer"/);
  assert.match(globalsCss, /\.ledger__row/);
  assert.match(globalsCss, /\.attention__row/);
  assert.doesNotMatch(reportsPage, /report-footer__compare/);
  assert.doesNotMatch(reportsPage, /report-metric/);
  assert.doesNotMatch(reportsPage, /report-action/);
  assert.doesNotMatch(reportsPage, /report-compare/);
  assert.doesNotMatch(globalsCss, /\.report-metric/);
  assert.doesNotMatch(globalsCss, /\.report-action/);
  assert.doesNotMatch(globalsCss, /\.report-compare/);
});

test("reports primary numbers come from the live inbox counts, not historical rows", () => {
  assert.doesNotMatch(reportsPage, /getAccountRecoveryStats/);
  assert.match(reportsPage, /const inboxCounts = await getLeadInboxCountsForAccount\(accountId\)/);
  assert.match(reportsPage, /booked: inboxCounts\.booked/);
  assert.match(reportsPage, /recoveredCents: inboxCounts\.bookedValueCents/);
  assert.match(reportsPage, /missedCalls: inboxCounts\.all/);
  assert.match(reportsPage, /value=\{String\(inboxCounts\.all\)\}/);
  assert.match(reportsPage, /value=\{String\(inboxCounts\.booked\)\}/);
  assert.match(reportsPage, /bookedValueLabel\(inboxCounts\.booked, inboxCounts\.bookedValueCents\)/);
  assert.doesNotMatch(reportsPage, /value=\{formatDollars\(inboxCounts\.bookedValueCents\)\}/);
});

test("reports never format missing booked value as zero dollars", () => {
  assert.match(reportsPage, /No values entered yet/);
  assert.match(reportsPage, /No booked value entered/);
  assert.match(reportsPage, /Add booked jobs first/);
  assert.doesNotMatch(reportsPage, /formatDollars\(0\)/);
  assert.doesNotMatch(reportsPage, />\$0</);
});

test("reports stats distinguish reply leads and booked jobs missing value", () => {
  assert.match(reportsData, /uniqueReplyLeads/);
  assert.match(reportsData, /bookedMissingValue/);
  assert.match(reportsData, /unlinkedReplyCount/);
  assert.match(reportsData, /account_business_recovery_stats/);
});

test("reports fail visibly if contact-aware aggregate data is unavailable", () => {
  assert.match(reportsData, /throwIfSupabaseError\(error\)/);
  assert.match(reportsData, /Business reporting is unavailable/);
  assert.doesNotMatch(reportsData, /uniqueReplyLeads: replies|falling back to raw reply count/);
});
