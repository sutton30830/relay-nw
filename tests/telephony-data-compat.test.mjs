import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Missing test mock for ${specifier} while loading ${path}`);
  };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const types = await loadTsModule("lib/telephony/types.ts");
const compatibility = await loadTsModule("lib/telephony/persistence.ts", {
  "@/lib/telephony/types": types,
});

test("legacy Twilio rows map to neutral runtime identifiers without changing values", () => {
  const mapped = compatibility.mapLegacyTelephonyRow({
    phone_number: " +12065550100 ",
    twilio_sid: " PN_legacy ",
    call_sid: " CA_legacy ",
    twilio_message_sid: " SM_legacy ",
    recording_sid: " RE_legacy ",
  });

  assert.deepEqual(mapped, {
    telephonyProvider: "twilio",
    relayPhoneNumber: "+12065550100",
    providerNumberId: { provider: "twilio", kind: "number", value: "PN_legacy" },
    providerCallId: { provider: "twilio", kind: "call", value: "CA_legacy" },
    providerMessageId: { provider: "twilio", kind: "message", value: "SM_legacy" },
    providerRecordingId: { provider: "twilio", kind: "recording", value: "RE_legacy" },
  });
});

test("missing provider state defaults to Twilio and rolling runtime aliases remain readable", () => {
  assert.equal(compatibility.persistedTelephonyProviderId(), "twilio");
  assert.equal(compatibility.persistedTelephonyProviderId(null), "twilio");
  assert.equal(compatibility.persistedTelephonyProviderId(" TWILIO "), "twilio");
  assert.equal(
    compatibility.relayPhoneNumberFromRuntime({ relayPhoneNumber: "+12065550101" }),
    "+12065550101",
  );
  assert.equal(
    compatibility.relayPhoneNumberFromRuntime({ twilioPhoneNumber: "+12065550102" }),
    "+12065550102",
  );
});

test("unknown or not-yet-persistable providers fail closed at the legacy storage boundary", () => {
  assert.throws(
    () => compatibility.persistedTelephonyProviderId("carrier-x"),
    /Unsupported persisted telephony provider: carrier-x/,
  );
  assert.throws(
    () => compatibility.legacyProviderValue({
      provider: "dial",
      kind: "number",
      value: "future-number-id",
    }),
    /Unsupported persisted telephony provider: dial/,
  );
});

test("legacy schema, RPC, uniqueness, RLS, and reporting contracts remain intact", async () => {
  const [sql, accounts, messages, monitoring, reports] = await Promise.all([
    readFile(new URL("../supabase.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/supabase/accounts.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/supabase/messages.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/supabase/monitoring.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/supabase/reports.ts", import.meta.url), "utf8"),
  ]);

  for (const column of ["twilio_sid", "call_sid", "twilio_message_sid", "recording_sid"]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  assert.match(sql, /create unique index if not exists account_phone_numbers_phone_unique_idx/);
  assert.match(sql, /account_phone_numbers_one_primary_per_account_idx/);
  assert.match(sql, /leads_account_call_sid_unique_idx/);
  assert.match(sql, /leads_account_twilio_message_sid_unique_idx/);
  assert.match(sql, /unique \(account_id, twilio_message_sid\)/);
  assert.match(sql, /alter table public\.account_phone_numbers enable row level security/);
  assert.match(sql, /create policy deny_client_access on public\.account_phone_numbers/);
  assert.match(sql, /create or replace function public\.assign_primary_account_phone_number\([\s\S]*p_twilio_sid text/);
  assert.match(sql, /create or replace function public\.create_missed_call_lead_and_mark_live\([\s\S]*p_call_sid text/);

  assert.match(accounts, /resolveAccountByRelayPhoneNumber/);
  assert.match(accounts, /\.from\("account_phone_numbers"\)[\s\S]*\.eq\("account_id", accountId\)/);
  assert.match(accounts, /p_twilio_sid: providerNumberId/);
  assert.match(messages, /twilio_message_sid: input\.providerMessageId \?\? input\.twilioMessageSid \?\? null/);
  assert.match(messages, /\.eq\("account_id", accountId\)[\s\S]*\.eq\("twilio_message_sid", providerMessageId\)/);

  // Operational evidence still reports actual Twilio facts from historical rows.
  assert.match(monitoring, /select\("account_id, lead_id, direction, status, twilio_message_sid, created_at"\)/);
  assert.match(monitoring, /row\.provider === "twilio"/);
  assert.match(reports, /\.from\("leads"\)[\s\S]*\.eq\("account_id", accountId\)/);
});
