import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Weekly recap email: honest about texting, delivery, and dollars.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function loadTs(path, mocks = {}) {
  const compiled = ts.transpileModule(await read(path), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const require = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Missing mock: ${id}`);
  };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const reportHero = await loadTs("lib/report-hero.ts");
const { buildWeeklyDigest } = await loadTs("lib/weekly-digest.ts", { "@/lib/report-hero": reportHero });

const stats = (over = {}) => ({
  missedCalls: 9,
  textedBack: 0,
  textedDelivered: 0,
  smsFailed: 0,
  urgent: 2,
  replies: 0,
  uniqueReplyLeads: 0,
  booked: 0,
  bookedMissingValue: 0,
  recoveredCents: 0,
  voicemails: 5,
  voicemailsWithRequest: 4,
  ...over,
});

const base = {
  businessName: "RYCO Property Maintenance",
  periodLabel: "this week",
  textingOn: false,
  typicalJobValueCents: null,
  appBaseUrl: "https://relay.test",
};

test("calls-only account gets one honest texting line instead of a column of zeros", () => {
  const digest = buildWeeklyDigest({ ...base, stats: stats() });
  assert.equal(digest.headline, "Relay caught 9 missed calls for RYCO Property Maintenance this week.");
  assert.deepEqual(digest.lines, [
    "Missed calls caught: 9",
    "Voicemails: 5, 4 with a clear request summarized for you.",
    "ASAP callbacks flagged: 2",
    "Auto-text: not on yet. Relay is completing carrier registration; callers were not texted this period.",
    'Jobs booked: none marked yet. Tap "Yes, booked" after a call-back so Relay can count it.',
  ]);
  assert.doesNotMatch(digest.lines.join("\n"), /Customer replies|texted back automatically|—/);
  assert.equal(digest.subject, "Your week with Relay NW: 9 missed calls caught");
  assert.equal(digest.actionUrl, "https://relay.test/reports");
});

test("sent is not delivered: delivered count leads, unconfirmed sends are named", () => {
  const digest = buildWeeklyDigest({ ...base, textingOn: true, stats: stats({ textedBack: 7, textedDelivered: 5, smsFailed: 1, replies: 3 }) });
  assert.ok(digest.lines.includes("Auto-texts delivered: 5 (2 more sent, delivery not confirmed), 1 failed"));
  assert.ok(digest.lines.includes("Customer replies: 3"));
});

test("booked jobs without values are counted, never shown as $0", () => {
  const digest = buildWeeklyDigest({ ...base, stats: stats({ booked: 2, bookedMissingValue: 2 }) });
  assert.match(digest.headline, /caught 9 missed calls/);
  assert.ok(digest.lines.includes("2 jobs booked from Relay leads. Add job values and next week's recap will show dollars."));
  assert.doesNotMatch(digest.lines.join("\n"), /\$0\b/);
});

test("entered values are facts; typical-value estimates are labelled estimates", () => {
  const entered = buildWeeklyDigest({ ...base, stats: stats({ booked: 2, bookedMissingValue: 0, recoveredCents: 85000 }) });
  assert.equal(entered.headline, "Relay booked $850 for RYCO Property Maintenance this week.");
  assert.ok(entered.lines.includes("$850 booked from Relay leads. 2 jobs currently marked booked."));
  assert.ok(entered.lines.includes("Based on job values you entered."));
  assert.match(entered.subject, /\$850 booked$/);

  const estimated = buildWeeklyDigest({ ...base, typicalJobValueCents: 30000, stats: stats({ booked: 3, bookedMissingValue: 1, recoveredCents: 85000 }) });
  assert.match(estimated.headline, /≈ \$1,150/);
  assert.ok(estimated.lines.some((line) => /Estimated using your typical job value of \$300/.test(line)));
});

test("singulars read naturally", () => {
  const digest = buildWeeklyDigest({ ...base, stats: stats({ missedCalls: 1, voicemails: 0 }) });
  assert.match(digest.headline, /caught 1 missed call for/);
  assert.ok(digest.lines.includes("Voicemails: none left."));
});

test("recovery stats gather delivered, voicemail, and summarized counts per account", async () => {
  const reports = await read("lib/supabase/reports.ts");
  assert.match(reports, /textedDelivered: number;/);
  assert.match(reports, /query\.eq\("sms_status", "delivered"\)/);
  assert.match(reports, /query\.not\("recording_sid", "is", null\)\.gte\("recording_duration", MIN_VOICEMAIL_DURATION_SECONDS\)/);
  assert.match(reports, /query\.not\("voicemail_summary", "is", null\)/);
  assert.match(reports, /countLeadsWhere\(accountId, since, until/);
});

test("digest route and email use the shared builder and pass texting state", async () => {
  const route = await read("app/api/digest/weekly/route.ts");
  const email = await read("lib/email.ts");
  assert.match(route, /textingOn: account\.smsEnabled,/);
  assert.match(email, /const \{ buildWeeklyDigest \} = await import\("@\/lib\/weekly-digest"\);/);
  assert.match(email, /typicalJobValueCents: input\.account\.typicalJobValueCents,/);
  assert.doesNotMatch(email, /Callers texted back automatically/);
});

test("email lines carry no typographic dashes or middle dots", () => {
  const digest = buildWeeklyDigest({ ...base, typicalJobValueCents: 35000, stats: stats({ booked: 2, bookedMissingValue: 1, recoveredCents: 50000 }) });
  assert.doesNotMatch(digest.lines.join("\n"), /—|·/);
  assert.ok(digest.lines.includes("Based on job values you entered. Estimated using your typical job value of $350 (set in Settings)."));
});
