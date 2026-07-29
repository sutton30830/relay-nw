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
      this.countMode = null;
      this.rangeStart = null;
      this.rangeEnd = null;
      this.singleMode = null;
      this.conflictColumns = [];
    }

    select(columns = "*", options = {}) {
      this.columns = columns;
      this.countMode = options.count ?? null;
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

    delete() {
      this.action = "delete";
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

    range(start, end) {
      this.rangeStart = start;
      this.rangeEnd = end;
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

      if (this.action === "delete") {
        resultRows = rows.filter((row) => matches(row, this.filters));
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (matches(rows[index], this.filters)) rows.splice(index, 1);
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

      const count = this.countMode === "exact" ? resultRows.length : null;

      if (this.rangeStart !== null && this.rangeEnd !== null) {
        resultRows = resultRows.slice(this.rangeStart, this.rangeEnd + 1);
      }

      if (this.limitCount !== null) {
        resultRows = resultRows.slice(0, this.limitCount);
      }

      let data = project(this.tableName, resultRows, this.columns);
      if (this.singleMode) {
        data = data[0] ?? null;
      }

      return { data, error: null, count };
    }
  }

  function leadSearchText(lead) {
    return [
      lead.name || "Unknown caller",
      lead.phone,
      lead.message,
      lead.notes,
      lead.voicemail_summary,
      lead.voicemail_transcript,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function condenseLeadRows(rows) {
    const newestByPhone = new Map();

    for (const lead of rows) {
      const bucket = `${lead.phone}:${lead.deleted_at ? "trash" : "live"}`;
      const current = newestByPhone.get(bucket);
      if (!current || lead.created_at > current.created_at || (lead.created_at === current.created_at && lead.id > current.id)) {
        newestByPhone.set(bucket, lead);
      }
    }

    return rows.filter((lead) => newestByPhone.get(`${lead.phone}:${lead.deleted_at ? "trash" : "live"}`)?.id === lead.id);
  }

  function leadInboxCounts(params) {
    const rollup = condenseLeadRows(table("leads").filter((lead) => lead.account_id === params.p_account));
    const visible = rollup.filter((lead) => !lead.deleted_at);
    const booked = visible.filter((lead) => lead.booked_at || lead.status === "booked");

    return {
      all_count: visible.length,
      new_count: visible.filter((lead) => lead.status === "new").length,
      actionable_count: visible.filter((lead) => lead.status === "new" || lead.status === "contacted").length,
      contacted_count: visible.filter((lead) => lead.status === "contacted").length,
      booked_count: booked.length,
      dead_count: visible.filter((lead) => lead.status === "dead").length,
      trash_count: rollup.filter((lead) => lead.deleted_at).length,
      sms_issues_count: visible.filter((lead) => lead.status === "new" && ["failed", "undelivered"].includes(lead.sms_status)).length,
      booked_value_cents: booked.reduce((sum, lead) => sum + (lead.job_value_cents ?? 0), 0),
      booked_with_value_count: booked.filter((lead) => (lead.job_value_cents ?? 0) > 0).length,
    };
  }

  function searchLeadInbox(params) {
    const filter = params.p_filter ?? "all";
    const query = String(params.p_query ?? "").trim().toLowerCase();
    const limit = params.p_limit ?? 50;
    const offset = params.p_offset ?? 0;
    const accountLeads = table("leads").filter((lead) => lead.account_id === params.p_account);
    const callCounts = new Map();

    for (const lead of accountLeads) {
      callCounts.set(lead.phone, (callCounts.get(lead.phone) ?? 0) + 1);
    }

    const sourceRows = condenseLeadRows(accountLeads);
    const filtered = sourceRows
      .filter((lead) => {
        const inTrash = Boolean(lead.deleted_at);
        if (filter === "trash" ? !inTrash : inTrash) return false;
        if (filter === "booked" && !(lead.booked_at || lead.status === "booked")) return false;
        if (!["all", "trash", "booked"].includes(filter) && lead.status !== filter) return false;
        return !query || leadSearchText(lead).includes(query);
      })
      .sort((a, b) => {
        if (a.created_at < b.created_at) return 1;
        if (a.created_at > b.created_at) return -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

    const total = filtered.length;

    return filtered.slice(offset, offset + limit).map((lead) => ({
      ...lead,
      call_count: callCounts.get(lead.phone) ?? 1,
      total_count: total,
    }));
  }

  function rpcResult(data, error = null) {
    const promise = Promise.resolve({ data, error });
    return {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
      maybeSingle() {
        const row = Array.isArray(data) ? (data[0] ?? null) : data;
        return Promise.resolve({ data: row, error });
      },
    };
  }

  return {
    tables,
    client: {
      from(tableName) {
        return new Query(tableName);
      },
      rpc(name, params) {
        if (name === "search_lead_inbox") {
          return rpcResult(searchLeadInbox(params));
        }
        if (name === "lead_inbox_counts") {
          return rpcResult(leadInboxCounts(params));
        }
        if (name === "create_missed_call_lead_and_mark_live") {
          const leads = table("leads");
          const duplicate = leads.find(
            (lead) =>
              lead.account_id === params.p_account_id &&
              lead.call_sid === params.p_call_sid,
          );

          if (duplicate) {
            return rpcResult([{
              inserted: false,
              lead_id: null,
              lead_created_at: null,
              became_live: false,
            }]);
          }

          const createdAt = new Date().toISOString();
          const leadId = randomUUID();
          leads.push({
            id: leadId,
            created_at: createdAt,
            account_id: params.p_account_id,
            call_sid: params.p_call_sid,
            phone: params.p_phone,
            message: params.p_message,
            sms_status: "pending",
            source: "missed_call",
            status: "new",
          });

          return rpcResult([{
            inserted: true,
            lead_id: leadId,
            lead_created_at: createdAt,
            became_live: false,
          }]);
        }
        if (name === "assign_primary_account_phone_number") {
          const numbers = table("account_phone_numbers");
          const account = table("accounts").find(
            (row) => row.id === params.p_account_id,
          );
          if (!account || account.status === "archived") {
            return rpcResult(null, new Error("Target account cannot receive a number"));
          }
          const existing = numbers.find(
            (row) => row.phone_number === params.p_phone_number,
          );
          if (existing && existing.account_id !== params.p_account_id) {
            return rpcResult(
              null,
              Object.assign(
                new Error("Relay number is already assigned to another account"),
                { code: "23505" },
              ),
            );
          }
          const previous = numbers.find(
            (row) => row.account_id === params.p_account_id && row.is_primary,
          )?.phone_number ?? null;
          for (const row of numbers) {
            if (row.account_id === params.p_account_id) row.is_primary = false;
          }
          if (existing) {
            existing.is_primary = true;
            existing.twilio_sid = params.p_twilio_sid;
          } else {
            numbers.push({
              id: randomUUID(),
              account_id: params.p_account_id,
              phone_number: params.p_phone_number,
              twilio_sid: params.p_twilio_sid,
              is_primary: true,
            });
          }
          return rpcResult([{
            number_changed: previous !== params.p_phone_number,
            previous_phone_number: previous,
          }]);
        }
        if (name === "release_closed_account_phone_numbers") {
          const account = table("accounts").find(
            (row) => row.id === params.p_account_id,
          );
          if (
            !account ||
            account.status !== "archived" ||
            account.onboarding_status !== "closed"
          ) {
            return rpcResult(
              null,
              new Error("Relay numbers can only be released from a closed archived account"),
            );
          }
          const numbers = table("account_phone_numbers");
          const released = numbers
            .filter((row) => row.account_id === params.p_account_id)
            .map((row) => ({ phone_number: row.phone_number }));
          for (let index = numbers.length - 1; index >= 0; index -= 1) {
            if (numbers[index].account_id === params.p_account_id) {
              numbers.splice(index, 1);
            }
          }
          return rpcResult(released);
        }

        throw new Error(`Unsupported rpc ${name}`);
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
    "@/lib/billing": {
      normalizeCommercialOffer: (value) =>
        value === "founding_pilot" ? "founding_pilot" : "standard",
    },
    "@/lib/customer-experience-contract": {},
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
    "./tenant": tenantMock,
  });
  const carrierProfiles = await loadTsModule("lib/supabase/carrier-profiles.ts", {
    "./client": clientMock,
    "./tenant": tenantMock,
  });
  const audit = await loadTsModule("lib/supabase/audit.ts", {
    "./client": clientMock,
    "./tenant": tenantMock,
  });

  return { accounts, audit, calls, carrierProfiles, leads, messages, voicemails };
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
    account_carrier_profiles: [
      {
        account_id: "acct-a",
        status: "approved",
        twilio_brand_sid: "BN_A",
        twilio_campaign_sid: "QE_A",
        messaging_service_sid: "MG_A",
        status_detail: "Account A approved",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        account_id: "acct-b",
        status: "in_progress",
        twilio_brand_sid: "BN_B",
        twilio_campaign_sid: "QE_B",
        messaging_service_sid: "MG_B",
        status_detail: "Account B pending",
        updated_at: "2026-01-02T00:00:00.000Z",
      },
    ],
    account_audit_events: [
      {
        id: "audit-a",
        account_id: "acct-a",
        actor_user_id: "user-a",
        actor_email: "a@example.com",
        action: "fixture.a",
        summary: "Account A event",
      },
      {
        id: "audit-b",
        account_id: "acct-b",
        actor_user_id: "user-b",
        actor_email: "b@example.com",
        action: "fixture.b",
        summary: "Account B event",
      },
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
    opt_outs: [
      { id: "opt-a", account_id: "acct-a", phone: "+15553330001" },
      { id: "opt-b", account_id: "acct-b", phone: "+15553330002" },
    ],
  };
}

test("carrier profiles, account audit events, and opt-outs remain account scoped", async () => {
  const fake = createSupabaseFake(seedData());
  const { audit, carrierProfiles, messages } = await loadStores(fake);

  const profileA = await carrierProfiles.getCarrierProfile("acct-a");
  assert.equal(profileA?.accountId, "acct-a");
  assert.equal(profileA?.twilioBrandSid, "BN_A");

  const profileBBefore = structuredClone(
    fake.tables.account_carrier_profiles.find((row) => row.account_id === "acct-b"),
  );
  await carrierProfiles.upsertCarrierProfile("acct-a", {
    status: "ready",
    status_detail: "Account A is ready",
  });
  assert.equal(
    fake.tables.account_carrier_profiles.find((row) => row.account_id === "acct-a")?.status,
    "ready",
  );
  assert.deepEqual(
    fake.tables.account_carrier_profiles.find((row) => row.account_id === "acct-b"),
    profileBBefore,
  );

  const accountBAuditBefore = structuredClone(
    fake.tables.account_audit_events.filter((row) => row.account_id === "acct-b"),
  );
  await audit.recordAccountAuditEvents({
    accountId: "acct-a",
    actorUserId: "user-a",
    actorEmail: "a@example.com",
    events: [{
      action: "settings.updated",
      summary: "Account A settings changed",
    }],
  }, { required: true });
  assert.equal(
    fake.tables.account_audit_events.filter(
      (row) => row.account_id === "acct-a" && row.action === "settings.updated",
    ).length,
    1,
  );
  assert.deepEqual(
    fake.tables.account_audit_events.filter((row) => row.account_id === "acct-b"),
    accountBAuditBefore,
  );

  assert.equal(await messages.isOptedOut("+15553330002", "acct-a"), false);
  assert.equal(await messages.isOptedOut("+15553330002", "acct-b"), true);
  await messages.clearOptOut("+15553330002", "acct-a");
  assert.equal(await messages.isOptedOut("+15553330002", "acct-b"), true);

  const sharedPhone = "+15553339999";
  await messages.recordOptOut(sharedPhone, "acct-a");
  await messages.recordOptOut(sharedPhone, "acct-b");
  assert.deepEqual(
    fake.tables.opt_outs
      .filter((row) => row.phone === sharedPhone)
      .map((row) => row.account_id)
      .sort(),
    ["acct-a", "acct-b"],
  );
});

test("account B cannot read account A leads", async () => {
  const fake = createSupabaseFake(seedData());
  const { leads } = await loadStores(fake);

  const accountBLeads = await leads.getLeadsForAccount("acct-b");

  assert.deepEqual(accountBLeads.map((lead) => lead.id), ["lead-b"]);
});

test("paginated lead inbox stays account scoped and bounded", async () => {
  const seed = seedData();
  seed.leads = [
    ...seed.leads,
    ...Array.from({ length: 4 }, (_, index) => ({
      ...seed.leads[1],
      id: `lead-b-extra-${index}`,
      call_sid: `CA_B_EXTRA_${index}`,
      phone: `+1555222000${index + 1}`,
      created_at: `2026-01-0${index + 3}T00:00:00.000Z`,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      ...seed.leads[0],
      id: `lead-a-extra-${index}`,
      call_sid: `CA_A_EXTRA_${index}`,
      phone: `+1555111000${index + 1}`,
      created_at: `2026-01-0${index + 3}T12:00:00.000Z`,
    })),
  ];
  const fake = createSupabaseFake(seed);
  const { leads } = await loadStores(fake);

  const page = await leads.getLeadInboxPageForAccount("acct-b", { limit: 2, offset: 2 });

  assert.equal(page.total, 5);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 2);
  assert.equal(page.leads.length, 2);
  assert.ok(page.leads.every((lead) => lead.account_id === "acct-b"));
  assert.deepEqual(page.leads.map((lead) => lead.id), ["lead-b-extra-1", "lead-b-extra-0"]);
});

test("server inbox counts match the same condensed booked cards returned by the inbox", async () => {
  const seed = seedData();
  seed.leads = [
    {
      ...seed.leads[0],
      id: "older-booked-a",
      phone: "+15551113333",
      booked_at: "2026-01-01T00:00:00.000Z",
      job_value_cents: 45000,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      ...seed.leads[0],
      id: "newer-unbooked-a",
      phone: "+15551113333",
      booked_at: null,
      job_value_cents: null,
      status: "new",
      created_at: "2026-01-02T00:00:00.000Z",
    },
    {
      ...seed.leads[0],
      id: "booked-b",
      phone: "+15551114444",
      booked_at: "2026-01-03T00:00:00.000Z",
      job_value_cents: 25000,
      created_at: "2026-01-03T00:00:00.000Z",
    },
    {
      ...seed.leads[0],
      id: "booked-c",
      phone: "+15551115555",
      booked_at: "2026-01-04T00:00:00.000Z",
      job_value_cents: null,
      created_at: "2026-01-04T00:00:00.000Z",
    },
    {
      ...seed.leads[0],
      id: "deleted-booked",
      phone: "+15551116666",
      booked_at: "2026-01-05T00:00:00.000Z",
      job_value_cents: 90000,
      deleted_at: "2026-01-05T01:00:00.000Z",
      created_at: "2026-01-05T00:00:00.000Z",
    },
  ];
  const fake = createSupabaseFake(seed);
  const { leads } = await loadStores(fake);

  const counts = await leads.getLeadInboxCountsForAccount("acct-a");
  const bookedPage = await leads.getLeadInboxPageForAccount("acct-a", { filter: "booked", limit: 10, offset: 0 });
  const allPage = await leads.getLeadInboxPageForAccount("acct-a", { filter: "all", limit: 10, offset: 0 });

  assert.equal(counts.all, allPage.total);
  assert.equal(counts.booked, bookedPage.total);
  assert.equal(bookedPage.leads.length, 2);
  assert.deepEqual(bookedPage.leads.map((lead) => lead.id), ["booked-c", "booked-b"]);
  assert.equal(counts.bookedValueCents, 25000);
  assert.equal(counts.bookedWithValue, 1);
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
    rawTranscript: "wrong tenant raw evidence",
    transcript: "wrong tenant",
    summary: "wrong tenant",
  });

  const accountALead = fake.tables.leads.find((lead) => lead.id === "lead-a");
  assert.equal(accountALead.voicemail_raw_transcript ?? null, null);
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
    twilioSignatureValid: true,
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

test("ambiguous provider identifiers and conflicting account evidence fail closed", async () => {
  const seed = seedData();
  seed.inbound_messages.push({
    id: "inbound-a-only",
    account_id: "acct-a",
    message_sid: "SM_INBOUND_ONLY",
    from_phone: "+15551110000",
    to_phone: "+15550001000",
    body: "inbound evidence",
  });
  seed.calls.push(
    {
      id: "call-a-ambiguous",
      account_id: "acct-a",
      call_sid: "CA_AMBIGUOUS",
    },
    {
      id: "call-b-ambiguous",
      account_id: "acct-b",
      call_sid: "CA_AMBIGUOUS",
    },
  );
  seed.messages.push(
    {
      id: "message-a-ambiguous",
      account_id: "acct-a",
      twilio_message_sid: "SM_AMBIGUOUS",
    },
    {
      id: "message-b-ambiguous",
      account_id: "acct-b",
      twilio_message_sid: "SM_AMBIGUOUS",
    },
  );
  const fake = createSupabaseFake(seed);
  const { accounts } = await loadStores(fake);

  const callFromLeadOnly = await accounts.resolveAccountByCallSid("CA_A");
  const messageFromLeadOnly = await accounts.resolveAccountByMessageSid("SM_A");
  const messageFromInboundOnly = await accounts.resolveAccountByMessageSid("SM_INBOUND_ONLY");
  assert.equal(callFromLeadOnly.status, "resolved");
  assert.equal(callFromLeadOnly.account.accountId, "acct-a");
  assert.equal(messageFromLeadOnly.status, "resolved");
  assert.equal(messageFromLeadOnly.account.accountId, "acct-a");
  assert.equal(messageFromInboundOnly.status, "resolved");
  assert.equal(messageFromInboundOnly.account.accountId, "acct-a");

  const ambiguousCall = await accounts.resolveAccountByCallSid("CA_AMBIGUOUS");
  const ambiguousMessage = await accounts.resolveAccountByMessageSid("SM_AMBIGUOUS");
  assert.equal(ambiguousCall.status, "unresolved");
  assert.equal(ambiguousCall.reason, "call_sid_ambiguous");
  assert.equal(ambiguousMessage.status, "unresolved");
  assert.equal(ambiguousMessage.reason, "message_sid_ambiguous");

  const [byA, byB] = await Promise.all([
    accounts.resolveAccountByTwilioNumber("+15550001000"),
    accounts.resolveAccountByTwilioNumber("+15550002000"),
  ]);
  const mismatch = accounts.resolveConsistentAccountEvidence([
    { label: "CallSid", resolution: byA },
    { label: "To", resolution: byB },
  ]);
  assert.equal(mismatch.status, "unresolved");
  assert.equal(mismatch.reason, "provider_account_evidence_mismatch");

  const consistent = accounts.resolveConsistentAccountEvidence([
    { label: "CallSid", resolution: byA },
    {
      label: "To",
      resolution: {
        status: "unresolved",
        reason: "twilio_number_not_registered",
        lookupValue: "+15559999999",
      },
    },
  ]);
  assert.equal(consistent.status, "resolved");
  assert.equal(consistent.account.accountId, "acct-a");
});

test("relay-number assignment cannot steal or race another account's number, and release stays scoped", async () => {
  const seed = seedData();
  seed.accounts[0].onboarding_status = "live";
  seed.accounts[1].onboarding_status = "live";
  const fake = createSupabaseFake(seed);
  const { accounts } = await loadStores(fake);

  await assert.rejects(
    () => accounts.assignPrimaryAccountPhoneNumber({
      accountId: "acct-a",
      phoneNumber: "+15550002000",
      twilioSid: "PN_B",
    }),
    /already assigned to another account/,
  );
  assert.equal(
    fake.tables.account_phone_numbers.find(
      (row) => row.phone_number === "+15550002000",
    ).account_id,
    "acct-b",
  );

  const race = await Promise.allSettled([
    accounts.assignPrimaryAccountPhoneNumber({
      accountId: "acct-a",
      phoneNumber: "+15550003000",
      twilioSid: "PN_NEW",
    }),
    accounts.assignPrimaryAccountPhoneNumber({
      accountId: "acct-b",
      phoneNumber: "+15550003000",
      twilioSid: "PN_NEW",
    }),
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(race.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    fake.tables.account_phone_numbers.filter(
      (row) => row.phone_number === "+15550003000",
    ).length,
    1,
  );

  await assert.rejects(
    () => accounts.releaseAccountPhoneNumbers("acct-b"),
    /closed archived account/,
  );
  const accountARow = fake.tables.accounts.find((row) => row.id === "acct-a");
  accountARow.status = "archived";
  accountARow.onboarding_status = "closed";
  const bNumbersBefore = fake.tables.account_phone_numbers
    .filter((row) => row.account_id === "acct-b")
    .map((row) => row.phone_number)
    .sort();
  const released = await accounts.releaseAccountPhoneNumbers("acct-a");
  assert.ok(released.length > 0);
  assert.deepEqual(
    fake.tables.account_phone_numbers
      .filter((row) => row.account_id === "acct-b")
      .map((row) => row.phone_number)
      .sort(),
    bNumbersBefore,
  );
});
