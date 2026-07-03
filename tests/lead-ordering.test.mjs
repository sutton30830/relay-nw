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

test("lead inbox sorting puts urgent work ahead of newer normal leads", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();

  const olderUrgent = lead({
    id: "older-urgent",
    message: "Need help ASAP",
    created_at: "2026-07-03T10:00:00.000Z",
  });
  const newerNormal = lead({
    id: "newer-normal",
    message: "Looking for a quote",
    created_at: "2026-07-03T11:00:00.000Z",
  });

  assert.deepEqual(
    sortLeadsForWork([olderUrgent, newerNormal]).map((item) => item.id),
    ["older-urgent", "newer-normal"],
  );
});

test("lead inbox sorting stays chronological within each priority group", async () => {
  const { sortLeadsForWork } = await loadLeadUtils();

  assert.deepEqual(
    sortLeadsForWork([
      lead({ id: "older-urgent", message: "Need help ASAP", created_at: "2026-07-03T10:00:00.000Z" }),
      lead({ id: "newer-urgent", message: "Need help ASAP", created_at: "2026-07-03T11:00:00.000Z" }),
      lead({ id: "older-normal", message: "Looking for a quote", created_at: "2026-07-03T09:00:00.000Z" }),
      lead({ id: "newer-normal", message: "Looking for a quote", created_at: "2026-07-03T12:00:00.000Z" }),
    ]).map((item) => item.id),
    ["newer-urgent", "older-urgent", "newer-normal", "older-normal"],
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
