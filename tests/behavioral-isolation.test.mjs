import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function normalizePhoneNumber(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";

  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

function assertAccountId(accountId, context) {
  const normalized = accountId?.trim();
  if (!normalized) {
    throw new Error(`Missing account_id for tenant-scoped Supabase operation: ${context}`);
  }
  return normalized;
}

async function loadTsModule(path, mocks) {
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

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

function createSupabaseFake(seed) {
  const tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
  );

  function table(name) {
    tables[name] ??= [];
    return tables[name];
  }

  function matches(row, filters) {
    return filters.every((filter) => {
      const value = row[filter.column];
      if (filter.op === "eq") return value === filter.value;
      if (filter.op === "neq") return value !== filter.value;
      if (filter.op === "in") return filter.value.includes(value);
      if (filter.op === "is") return value === filter.value;
      if (filter.op === "gte") return value >= filter.value;
      if (filter.op === "lt") return value < filter.value;
      throw new Error(`Unsupported filter ${filter.op}`);
    });
  }

  function project(tableName, rows, columns) {
    if (!columns || columns === "*") return rows.map((row) => ({ ...row }));

    const columnNames = columns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
      .filter((column) => !column.includes("("));

    return rows.map((row) => {
      const projected = {};
      for (const column of columnNames) {
        projected[column] = row[column] ?? null;
      }

      if (tableName === "account_settings" && columns.includes("accounts(")) {
        projected.accounts = table("accounts").find((account) => account.id === row.account_id)
          ? { slug: table("accounts").find((account) => account.id === row.account_id).slug }
          : null;
      }

      return projected;
    });
  }

  class Query {
    constructor(tableName) {
      this.tableName = tableName;
      this.action = "select";
      this.filters = [];
      this.orderBy = null;
      this.limitCount = null;
      this.payload = null;
      this.columns = "*";
      this.singleMode = null;
      this.conflictColumns = [];
    }

    select(columns = "*") {
      this.columns = columns;
      return this;
    }

    insert(payload) {
      this.action = "insert";
      this.payload = payload;
      return this;
    }

    update(payload) {
      this.action = "update";
      this.payload = payload;
      return this;
    }

    upsert(payload, options = {}) {
      this.action = "upsert";
      this.payload = payload;
      this.conflictColumns = options.onConflict?.split(",").map((column) => column.trim()) ?? [];
      return this;
    }

    eq(column, value) {
      this.filters.push({ op: "eq", column, value });
      return this;
    }

    neq(column, value) {
      this.filters.push({ op: "neq", column, value });
      return this;
    }

    in(column, value) {
      this.filters.push({ op: "in", column, value });
      return this;
    }

    is(column, value) {
      this.filters.push({ op: "is", column, value });
      return this;
    }

    gte(column, value) {
      this.filters.push({ op: "gte", column, value });
      return this;
    }

    lt(column, value) {
      this.filters.push({ op: "lt", column, value });
      return this;
    }

    order(column, options = {}) {
      this.orderBy = { column, ascending: options.ascending ?? true };
      return this;
    }

    limit(count) {
      this.limitCount = count;
      return this;
    }

    maybeSingle() {
      this.singleMode = "maybe";
      return this.execute();
    }

    single() {
      this.singleMode = "single";
      return this.execute();
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    async execute() {
      const rows = table(this.tableName);
      let resultRows = [];

      if (this.action === "select") {
        resultRows = rows.filter((row) => matches(row, this.filters));
      }

      if (this.action === "insert") {
        const insertedRows = (Array.isArray(this.payload) ? this.payload : [this.payload])
          .map((row) => ({ id: row.id ?? randomUUID(), created_at: row.created_at ?? new Date().toISOString(), ...row }));
        rows.push(...insertedRows);
        resultRows = insertedRows;
      }

      if (this.action === "update") {
        resultRows = rows.filter((row) => matches(row, this.filters));
        for (const row of resultRows) {
          Object.assign(row, this.payload);
        }
      }

      if (this.action === "upsert") {
        const conflictColumns = this.conflictColumns;
        const existing = conflictColumns.length
          ? rows.find((row) => conflictColumns.every((column) => row[column] === this.payload[column]))
          : null;

        if (existing) {
          Object.assign(existing, this.payload);
          resultRows = [existing];
        } else {
          const inserted = { id: this.payload.id ?? randomUUID(), created_at: new Date().toISOString(), ...this.payload };
          rows.push(inserted);
          resultRows = [inserted];
        }
      }

      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        resultRows = [...resultRows].sort((a, b) => {
          if ((a[column] ?? "") < (b[column] ?? "")) return ascending ? -1 : 1;
          if ((a[column] ?? "") > (b[column] ?? "")) return ascending ? 1 : -1;
          return 0;
        });
      }

      if (this.limitCount !== null) {
        resultRows = resultRows.slice(0, this.limitCount);
      }

      let data = project(this.tableName, resultRows, this.columns);
      if (this.singleMode) {
        data = data[0] ?? null;
      }

      return { data, error: null };
    }
  }

  return {
    tables,
    client: {
      from(tableName) {
        return new Query(tableName);
      },
    },
  };
}

async function loadStores(fake) {
  const clientMock = {
    isPlaceholderSupabaseConfig: () => false,
    shouldSkipDatabaseWrite: () => false,
    supabaseAdmin: fake.client,
    throwIfSupabaseError(error) {
      if (error) throw error;
    },
  };
  const tenantMock = { assertAccountId };

  const leads = await loadTsModule("lib/supabase/leads.ts", {
    "./client": clientMock,
    "./tenant": tenantMock,
    "./types": {},
  });
  const voicemails = await loadTsModule("lib/supabase/voicemails.ts", {
    "./client": clientMock,
    "./tenant": tenantMock,
    "./types": {},
  });
  const messages = await loadTsModule("lib/supabase/messages.ts", {
    "./client": clientMock,
    "./tenant": tenantMock,
    "./types": {},
  });
  const calls = await loadTsModule("lib/supabase/calls.ts", {
    "./client": clientMock,
    "./tenant": tenantMock,
  });
  const accounts = await loadTsModule("lib/supabase/accounts.ts", {
    "@/lib/env": {
      env: {
        appBaseUrl: "https://example.com",
        businessName: "Relay",
        callMode: "forwarding",
        defaultAccountSlug: "relay-nw",
        dialTimeoutSeconds: 18,
        intakeUrl: "https://example.com/intake",
        missedCallGreetingAudioUrl: null,
        missedCallSmsCooldownHours: 24,
        missedCallVoiceMessage: null,
        missedCallVoiceName: "Polly.Joanna-Neural",
        ownerPhoneNumber: "+15550000000",
        schedulingUrl: "https://example.com/book",
        smsEnabled: false,
        smsTemplate: null,
        supabaseServiceRoleKey: "service-role",
        supabaseUrl: "https://example.supabase.co",
        twilioPhoneNumber: "+15551111111",
        voicemailMaxSeconds: 60,
      },
    },
    "@/lib/phone": { normalizePhoneNumber },
    "./client": clientMock,
  });

  return { accounts, calls, leads, messages, voicemails };
}

function seedData() {
  return {
    accounts: [
      { id: "acct-a", slug: "account-a", name: "Account A", status: "active" },
      { id: "acct-b", slug: "account-b", name: "Account B", status: "active" },
    ],
    account_settings: [
      {
        account_id: "acct-a",
        business_name: "Account A",
        owner_email: "a@example.com",
        owner_phone_number: "+15550000001",
        intake_url: "https://a.example/intake",
        scheduling_url: "https://a.example/book",
        call_mode: "forwarding",
        sms_enabled: false,
        sms_template: null,
        missed_call_voice_message: null,
        missed_call_voice_name: null,
        missed_call_greeting_audio_url: null,
        voicemail_max_seconds: 60,
        dial_timeout_seconds: 18,
        missed_call_sms_cooldown_hours: 24,
        voicemail_transcription_enabled: true,
      },
      {
        account_id: "acct-b",
        business_name: "Account B",
        owner_email: "b@example.com",
        owner_phone_number: "+15550000002",
        intake_url: "https://b.example/intake",
        scheduling_url: "https://b.example/book",
        call_mode: "forwarding",
        sms_enabled: false,
        sms_template: null,
        missed_call_voice_message: null,
        missed_call_voice_name: null,
        missed_call_greeting_audio_url: null,
        voicemail_max_seconds: 60,
        dial_timeout_seconds: 18,
        missed_call_sms_cooldown_hours: 24,
        voicemail_transcription_enabled: true,
      },
    ],
    account_phone_numbers: [
      { id: "num-a", account_id: "acct-a", phone_number: "+15550001000", is_primary: true },
      { id: "num-b", account_id: "acct-b", phone_number: "+15550002000", is_primary: true },
    ],
    leads: [
      {
        id: "lead-a",
        account_id: "acct-a",
        call_sid: "CA_A",
        name: "A Caller",
        phone: "+15551110000",
        message: "A lead",
        notes: null,
        booked_at: null,
        job_value_cents: null,
        reply_priority_override: null,
        source: "missed_call",
        status: "new",
        sms_status: "pending",
        sms_error: null,
        twilio_message_sid: "SM_A",
        sms_updated_at: null,
        recording_sid: "RE_A",
        recording_url: "https://recordings.example/a.mp3",
        recording_duration: 12,
        recording_status: "completed",
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcription_error: null,
        voicemail_transcribed_at: null,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "lead-b",
        account_id: "acct-b",
        call_sid: "CA_B",
        name: "B Caller",
        phone: "+15552220000",
        message: "B lead",
        notes: null,
        booked_at: null,
        job_value_cents: null,
        reply_priority_override: null,
        source: "missed_call",
        status: "new",
        sms_status: "pending",
        sms_error: null,
        twilio_message_sid: "SM_B",
        sms_updated_at: null,
        recording_sid: "RE_B",
        recording_url: "https://recordings.example/b.mp3",
        recording_duration: 15,
        recording_status: "completed",
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcription_error: null,
        voicemail_transcribed_at: null,
        deleted_at: null,
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ],
    inbound_messages: [],
    calls: [],
    messages: [],
    opt_outs: [],
  };
}

test("account B cannot read account A leads", async () => {
  const fake = createSupabaseFake(seedData());
  const { leads } = await loadStores(fake);

  const accountBLeads = await leads.getLeadsForAccount("acct-b");

  assert.deepEqual(accountBLeads.map((lead) => lead.id), ["lead-b"]);
});

test("account B cannot update or delete account A lead by id", async () => {
  const fake = createSupabaseFake(seedData());
  const { leads } = await loadStores(fake);

  await leads.updateLead({ accountId: "acct-b", id: "lead-a", status: "dead", name: "Cross Tenant" });
  await leads.deleteLead("lead-a", "acct-b");

  const accountALead = fake.tables.leads.find((lead) => lead.id === "lead-a");
  assert.equal(accountALead.status, "new");
  assert.equal(accountALead.name, "A Caller");
  assert.equal(accountALead.deleted_at, null);
});

test("account B cannot play or transcribe account A voicemail", async () => {
  const fake = createSupabaseFake(seedData());
  const { voicemails } = await loadStores(fake);

  assert.equal(await voicemails.getLeadRecordingForPlayback("RE_A", "acct-b"), null);
  assert.equal(await voicemails.getLeadForVoicemailTranscription("lead-a", "acct-b"), null);

  await voicemails.updateLeadVoicemailTranscription({
    accountId: "acct-b",
    id: "lead-a",
    status: "completed",
    transcript: "wrong tenant",
    summary: "wrong tenant",
  });

  const accountALead = fake.tables.leads.find((lead) => lead.id === "lead-a");
  assert.equal(accountALead.voicemail_transcript, null);
  assert.equal(accountALead.voicemail_summary, null);
  assert.equal(accountALead.voicemail_transcription_status, "pending");
});

test("webhook resolution for number A and B writes rows under the resolved account", async () => {
  const fake = createSupabaseFake(seedData());
  const { accounts, calls, leads, messages } = await loadStores(fake);

  const accountAResolution = await accounts.resolveAccountByTwilioNumber("+1 (555) 000-1000");
  const accountBResolution = await accounts.resolveAccountByTwilioNumber("+1 (555) 000-2000");

  assert.equal(accountAResolution.status, "resolved");
  assert.equal(accountBResolution.status, "resolved");
  assert.equal(accountAResolution.account.accountId, "acct-a");
  assert.equal(accountBResolution.account.accountId, "acct-b");

  await calls.upsertCall({
    accountId: accountAResolution.account.accountId,
    callSid: "CA_WEBHOOK_A",
    fromPhone: "+15553330000",
    toPhone: accountAResolution.account.twilioPhoneNumber,
    status: "missed",
  });
  await leads.createMissedCallLeadIfNew({
    accountId: accountAResolution.account.accountId,
    callSid: "CA_WEBHOOK_A",
    phone: "+15553330000",
    message: null,
  });
  await messages.createInboundMessageIfNew({
    accountId: accountBResolution.account.accountId,
    messageSid: "SM_WEBHOOK_B",
    fromPhone: "+15554440000",
    toPhone: accountBResolution.account.twilioPhoneNumber,
    body: "hello",
  });

  assert.equal(fake.tables.calls.find((call) => call.call_sid === "CA_WEBHOOK_A").account_id, "acct-a");
  assert.equal(fake.tables.leads.find((lead) => lead.call_sid === "CA_WEBHOOK_A").account_id, "acct-a");
  assert.equal(fake.tables.inbound_messages.find((message) => message.message_sid === "SM_WEBHOOK_B").account_id, "acct-b");
});
