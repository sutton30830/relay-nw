import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadLeadUtils() {
  const source = await readFile(new URL("../app/leads/_utils.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier === "./_constants") {
      return {
        AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS: 10 * 60 * 1000,
        FAST_REPLY_PATTERNS: [{ pattern: /\basap\b/i, reason: "asked for ASAP help" }],
        LEGACY_FORWARDING_MESSAGE: "Forwarded missed call from existing business number.",
        TODAY_REPLY_PATTERNS: [{ pattern: /\btoday\b/i, reason: "asked about today" }],
      };
    }

    throw new Error(`Missing test mock for ${specifier}`);
  };

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, {
    filename: "app/leads/_utils.ts",
  });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

function lead(overrides) {
  return {
    id: "lead",
    phone: "+12065550123",
    name: null,
    message: null,
    notes: null,
    inbound_messages: [],
    voicemail_summary: null,
    voicemail_transcript: null,
    reply_priority_override: null,
    priority: null,
    priority_reason: null,
    source: "missed_call",
    status: "new",
    sms_status: null,
    recording_sid: null,
    booked_at: null,
    job_value_cents: null,
    deleted_at: null,
    created_at: "2026-07-03T12:00:00.000Z",
    ...overrides,
  };
}

test("all inbox sorting is chronological even when an older lead has priority language", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();
  const now = new Date("2026-07-03T12:00:00.000Z").getTime();

  const olderPriority = lead({
    id: "older-priority",
    message: "Water heater leaking; needs assistance fixing it.",
    priority: "today",
    priority_reason: "mentioned a leak",
    created_at: "2026-07-02T16:00:00.000Z",
  });
  const newerNormal = lead({
    id: "newer-normal",
    message: "No voicemail left.",
    created_at: "2026-07-03T05:00:00.000Z",
  });

  assert.deepEqual(sortLeadsForWork([olderPriority, newerNormal], now).map((item) => item.id), [
    "newer-normal",
    "older-priority",
  ]);
});

test("lead inbox sorting keeps newer normal leads above older urgent leads", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();
  const now = new Date("2026-07-03T12:00:00.000Z").getTime();

  const olderUrgent = lead({
    id: "older-urgent",
    status: "contacted",
    message: "Need help ASAP",
    created_at: "2026-07-03T10:00:00.000Z",
  });
  const newerNormal = lead({
    id: "newer-normal",
    message: "Looking for a quote",
    created_at: "2026-07-03T11:00:00.000Z",
  });

  assert.deepEqual(
    sortLeadsForWork([olderUrgent, newerNormal], now).map((item) => item.id),
    ["newer-normal", "older-urgent"],
  );
});

test("recent active leads do not get buried under stale priority language", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();
  const now = new Date("2026-07-03T12:00:00.000Z").getTime();

  const staleToday = lead({
    id: "stale-today",
    status: "contacted",
    message: "Can you come today?",
    created_at: "2026-06-29T12:00:00.000Z",
  });
  const recentNew = lead({
    id: "recent-new",
    message: "Missed call, no voicemail",
    created_at: "2026-07-03T05:00:00.000Z",
  });

  assert.deepEqual(
    sortLeadsForWork([staleToday, recentNew], now).map((item) => item.id),
    ["recent-new", "stale-today"],
  );
});

test("lead inbox sorting keeps a just-missed call easy to find above older urgent work", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();
  const now = new Date("2026-07-03T12:00:00.000Z").getTime();

  const olderUrgent = lead({
    id: "older-urgent",
    status: "contacted",
    message: "Need help ASAP",
    created_at: "2026-07-03T11:30:00.000Z",
  });
  const justMissed = lead({
    id: "just-missed",
    message: "Looking for a quote",
    created_at: "2026-07-03T11:59:00.000Z",
  });

  assert.deepEqual(
    sortLeadsForWork([olderUrgent, justMissed], now).map((item) => item.id),
    ["just-missed", "older-urgent"],
  );
});

test("fresh active leads stay newest first even when one is urgent", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();
  const now = new Date("2026-07-03T12:00:00.000Z").getTime();

  assert.deepEqual(
    sortLeadsForWork([
      lead({ id: "fresh-urgent", message: "Need help ASAP", created_at: "2026-07-03T11:50:00.000Z" }),
      lead({ id: "fresh-normal", message: "Looking for a quote", created_at: "2026-07-03T11:59:00.000Z" }),
    ], now).map((item) => item.id),
    ["fresh-normal", "fresh-urgent"],
  );
});

test("closed leads do not outrank active callback work", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();
  const now = new Date("2026-07-03T12:30:00.000Z").getTime();

  assert.deepEqual(
    sortLeadsForWork([
      lead({ id: "closed-today", status: "dead", message: "Can you come today?", created_at: "2026-07-03T12:00:00.000Z" }),
      lead({ id: "active-normal", status: "new", message: "Looking for a quote", created_at: "2026-07-03T11:00:00.000Z" }),
      lead({ id: "active-urgent", status: "contacted", message: "Need help ASAP", created_at: "2026-07-03T10:00:00.000Z" }),
    ], now).map((item) => item.id),
    ["closed-today", "active-normal", "active-urgent"],
  );
});

test("lead inbox sorting is chronological across priority groups", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();
  const now = new Date("2026-07-03T12:30:00.000Z").getTime();

  assert.deepEqual(
    sortLeadsForWork([
      lead({ id: "older-urgent", message: "Need help ASAP", created_at: "2026-07-03T10:00:00.000Z" }),
      lead({ id: "newer-urgent", message: "Need help ASAP", created_at: "2026-07-03T11:00:00.000Z" }),
      lead({ id: "older-normal", message: "Looking for a quote", created_at: "2026-07-03T09:00:00.000Z" }),
      lead({ id: "newer-normal", message: "Looking for a quote", created_at: "2026-07-03T12:00:00.000Z" }),
    ], now).map((item) => item.id),
    ["newer-normal", "newer-urgent", "older-urgent", "older-normal"],
  );
});

test("lead inbox sorting has a deterministic tie-break for identical timestamps", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();

  assert.deepEqual(
    sortLeadsForWork([
      lead({ id: "a", created_at: "2026-07-03T11:00:00.000Z" }),
      lead({ id: "b", created_at: "2026-07-03T11:00:00.000Z" }),
    ]).map((item) => item.id),
    ["b", "a"],
  );
});

test("lead search matches the visible Unknown caller label", async () => {
  const { leadMatchesSearch } = await loadLeadUtils();

  assert.equal(leadMatchesSearch(lead({ name: null }), "unknown"), true);
  assert.equal(leadMatchesSearch(lead({ name: "" }), "unknown caller"), true);
  assert.equal(leadMatchesSearch(lead({ name: "Joey" }), "unknown"), false);
});

test("booked leads remain in their workflow status filters", async () => {
  const { countLeads, filterLeads } = await loadLeadUtils();
  const openLead = lead({ id: "open-lead", status: "new" });
  const bookedLead = lead({
    id: "booked-lead",
    status: "contacted",
    booked_at: "2026-07-03T12:30:00.000Z",
  });
  const closedLead = lead({ id: "closed-lead", status: "dead" });

  const leads = [openLead, bookedLead, closedLead];

  assert.deepEqual(filterLeads(leads, "new", "").map((item) => item.id), ["open-lead"]);
  assert.deepEqual(filterLeads(leads, "contacted", "").map((item) => item.id), ["booked-lead"]);
  assert.equal(countLeads(leads).new, 1);
  assert.equal(countLeads(leads).contacted, 1);
  assert.equal(countLeads(leads).booked, 1);
  assert.equal(countLeads(leads).dead, 1);
});

test("current mailbox booked counts follow condensed visible caller cards", async () => {
  const { condenseLeadsByPhone, countLeads, filterLeads } = await loadLeadUtils();
  const olderBooked = lead({
    id: "older-booked",
    phone: "+12065550111",
    status: "contacted",
    booked_at: "2026-07-03T10:00:00.000Z",
    job_value_cents: 40000,
    created_at: "2026-07-03T10:00:00.000Z",
  });
  const newerUnbooked = lead({
    id: "newer-unbooked",
    phone: "+12065550111",
    status: "new",
    booked_at: null,
    job_value_cents: null,
    created_at: "2026-07-03T11:00:00.000Z",
  });
  const distinctBookedA = lead({
    id: "distinct-booked-a",
    phone: "+12065550112",
    status: "new",
    booked_at: "2026-07-03T11:30:00.000Z",
    job_value_cents: 25000,
  });
  const distinctBookedB = lead({
    id: "distinct-booked-b",
    phone: "+12065550113",
    status: "dead",
    booked_at: "2026-07-03T11:45:00.000Z",
    job_value_cents: null,
  });

  const currentMailbox = condenseLeadsByPhone([
    olderBooked,
    newerUnbooked,
    distinctBookedA,
    distinctBookedB,
  ]).leads;

  assert.deepEqual(currentMailbox.map((item) => item.id).sort(), [
    "distinct-booked-a",
    "distinct-booked-b",
    "newer-unbooked",
  ]);
  assert.equal(countLeads(currentMailbox).all, 3);
  assert.equal(countLeads(currentMailbox).booked, 2);
  assert.equal(countLeads(currentMailbox).bookedValueCents, 25000);
  assert.equal(countLeads(currentMailbox).bookedWithValue, 1);
  assert.deepEqual(filterLeads(currentMailbox, "booked", "").map((item) => item.id).sort(), [
    "distinct-booked-a",
    "distinct-booked-b",
  ]);
});

test("two booked rows for one phone produce one booked card and one booked count", async () => {
  const { condenseLeadsByPhone, countLeads, filterLeads } = await loadLeadUtils();
  const currentMailbox = condenseLeadsByPhone([
    lead({
      id: "older-booked",
      phone: "+12065550114",
      booked_at: "2026-07-03T10:00:00.000Z",
      job_value_cents: 25000,
      created_at: "2026-07-03T10:00:00.000Z",
    }),
    lead({
      id: "newer-booked",
      phone: "+12065550114",
      booked_at: "2026-07-03T11:00:00.000Z",
      job_value_cents: 50000,
      created_at: "2026-07-03T11:00:00.000Z",
    }),
  ]).leads;

  assert.deepEqual(currentMailbox.map((item) => item.id), ["newer-booked"]);
  assert.equal(countLeads(currentMailbox).booked, 1);
  assert.equal(countLeads(currentMailbox).bookedValueCents, 50000);
  assert.equal(filterLeads(currentMailbox, "booked", "").length, countLeads(currentMailbox).booked);
});

test("booked value helpers treat empty or zero as missing, not zero dollars", async () => {
  const { centsToInputValue, dollarsToCents, formatCurrency } = await loadLeadUtils();

  assert.equal(centsToInputValue(null), "");
  assert.equal(centsToInputValue(0), "");
  assert.equal(dollarsToCents(""), null);
  assert.equal(dollarsToCents("0"), null);
  assert.equal(dollarsToCents("$0"), null);
  assert.equal(formatCurrency(null), "No value entered");
  assert.equal(formatCurrency(0), "No value entered");
  assert.equal(formatCurrency(12500), "$125");
});
