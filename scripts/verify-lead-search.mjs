// Cross-checks the server-side lead inbox RPCs (search_lead_inbox,
// lead_inbox_counts) against a from-scratch JS reimplementation of the client's
// condense/count/filter logic, run over EVERY raw lead for an account. The point
// is to prove the SQL sees the whole account the same way the old client-only
// path saw a single loaded page — so filter-pill counts, the Booked tab, and
// search agree no matter how many pages of leads exist.
//
// Usage:
//   node scripts/verify-lead-search.mjs [accountId] [searchQuery]
// With no accountId, picks the account with the most leads. searchQuery
// defaults to a token drawn from real data so the search path is exercised.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function parseDotenvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

async function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    const contents = await readFile(file, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      process.env[key] ??= value;
    }
  }
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function optionalEnv(name) {
  return process.env[name] || null;
}

// --- JS mirror of the client logic (app/leads/_utils.ts). Kept deliberately
//     literal so it's an independent check, not a re-import of the same code. ---

function isBookedLead(lead) {
  return Boolean(lead.booked_at || lead.status === "booked");
}

function needsAttention(lead) {
  return lead.status === "new" && (lead.sms_status === "failed" || lead.sms_status === "undelivered");
}

// Newest row per phone, over whatever subset is passed in.
function condenseByPhone(leads) {
  const newestByPhone = new Map();
  for (const lead of leads) {
    const current = newestByPhone.get(lead.phone);
    if (!current || new Date(lead.created_at).getTime() > new Date(current.created_at).getTime()) {
      newestByPhone.set(lead.phone, lead);
    }
  }
  return leads.filter((lead) => newestByPhone.get(lead.phone)?.id === lead.id);
}

function countLeads(leads) {
  const visible = leads.filter((lead) => !lead.deleted_at);
  return {
    all: visible.length,
    new: visible.filter((l) => l.status === "new").length,
    actionable: visible.filter((l) => l.status === "new" || l.status === "contacted").length,
    contacted: visible.filter((l) => l.status === "contacted").length,
    booked: visible.filter(isBookedLead).length,
    dead: visible.filter((l) => l.status === "dead").length,
    trash: leads.filter((l) => l.deleted_at).length,
    smsIssues: visible.filter(needsAttention).length,
    bookedValueCents: visible.filter(isBookedLead).reduce((t, l) => t + (l.job_value_cents ?? 0), 0),
    bookedWithValue: visible.filter((l) => isBookedLead(l) && l.job_value_cents).length,
  };
}

// Server search scope: name/phone/message/notes/voicemail (NOT inbound SMS
// bodies or derived labels — matches search_lead_inbox by design).
function matchesSearch(lead, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [lead.name, lead.phone, lead.message, lead.notes, lead.voicemail_summary, lead.voicemail_transcript]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

function filterLeads(leads, filter, query) {
  return leads.filter((lead) => {
    if (filter === "trash") return Boolean(lead.deleted_at) && matchesSearch(lead, query);
    if (lead.deleted_at) return false;
    const matchesFilter = filter === "all" || (filter === "booked" && isBookedLead(lead)) || lead.status === filter;
    return matchesFilter && matchesSearch(lead, query);
  });
}

// The migrated-booked normalization the data layer applies (normalizeLead):
// legacy status='booked' rows are shown as 'dead' with booked_at set.
function normalize(lead) {
  if (lead.status !== "booked") return lead;
  return { ...lead, booked_at: lead.booked_at ?? lead.created_at, status: "dead" };
}

function condensedUnion(rawLeads) {
  const live = condenseByPhone(rawLeads.filter((l) => !l.deleted_at));
  const trash = condenseByPhone(rawLeads.filter((l) => l.deleted_at));
  return [...live, ...trash];
}

const FILTERS = ["all", "new", "contacted", "booked", "dead", "trash"];
const PAGE_LIMIT = 100;

function fmt(obj) {
  return JSON.stringify(obj);
}

async function main() {
  await loadLocalEnv();

  const supabaseUrl = optionalEnv("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
  const supabase = createClient(supabaseUrl, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let accountId = process.argv[2]?.trim() || null;
  const searchArg = process.argv[3]?.trim() || null;

  if (!accountId) {
    const { data, error } = await supabase.from("leads").select("account_id");
    if (error) throw error;
    const counts = new Map();
    for (const row of data ?? []) counts.set(row.account_id, (counts.get(row.account_id) ?? 0) + 1);
    accountId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!accountId) {
      console.error("No leads found in any account.");
      process.exit(1);
    }
    console.log(`No accountId given — using busiest account ${accountId} (${counts.get(accountId)} raw leads).\n`);
  }

  // Pull every raw lead for the account (the whole point: cross-check spans all pages).
  const rawLeads = [];
  const columns =
    "id, name, phone, message, notes, booked_at, job_value_cents, source, status, sms_status, voicemail_summary, voicemail_transcript, deleted_at, created_at";
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("leads")
      .select(columns)
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    rawLeads.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const normalized = rawLeads.map(normalize);

  console.log(`Account ${accountId}: ${rawLeads.length} raw lead rows.\n`);

  let failures = 0;
  const fail = (label, expected, actual) => {
    failures += 1;
    console.log(`  [FAIL] ${label}\n         expected ${fmt(expected)}\n         actual   ${fmt(actual)}`);
  };
  const pass = (label) => console.log(`  [PASS] ${label}`);

  // ---- 1. Counts ----
  console.log("Counts (lead_inbox_counts vs JS countLeads over condensed union):");
  const jsCounts = countLeads(condensedUnion(normalized));
  const { data: countRow, error: countErr } = await supabase
    .rpc("lead_inbox_counts", { p_account: accountId })
    .maybeSingle();
  if (countErr) throw countErr;
  const rpcCounts = {
    all: Number(countRow.all_count),
    new: Number(countRow.new_count),
    actionable: Number(countRow.actionable_count),
    contacted: Number(countRow.contacted_count),
    booked: Number(countRow.booked_count),
    dead: Number(countRow.dead_count),
    trash: Number(countRow.trash_count),
    smsIssues: Number(countRow.sms_issues_count),
    bookedValueCents: Number(countRow.booked_value_cents),
    bookedWithValue: Number(countRow.booked_with_value_count),
  };
  for (const key of Object.keys(jsCounts)) {
    if (jsCounts[key] === rpcCounts[key]) pass(`count.${key} = ${jsCounts[key]}`);
    else fail(`count.${key}`, jsCounts[key], rpcCounts[key]);
  }

  // ---- 2. Filtered result sets (id + total), across every filter ----
  console.log("\nFilter result sets (search_lead_inbox vs JS filterLeads over condensed union):");
  const union = condensedUnion(normalized);
  for (const filter of FILTERS) {
    const jsRows = filterLeads(union, filter, "")
      .slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id.localeCompare(a.id));
    const jsIds = jsRows.map((l) => l.id);

    // Page through the RPC to gather every id for this filter.
    const rpcIds = [];
    let total = null;
    for (let offset = 0; ; offset += PAGE_LIMIT) {
      const { data, error } = await supabase.rpc("search_lead_inbox", {
        p_account: accountId,
        p_filter: filter,
        p_query: "",
        p_limit: PAGE_LIMIT,
        p_offset: offset,
      });
      if (error) throw error;
      if (!data || data.length === 0) break;
      if (total === null) total = Number(data[0].total_count);
      rpcIds.push(...data.map((r) => r.id));
      if (data.length < PAGE_LIMIT) break;
    }

    const idsMatch = jsIds.length === rpcIds.length && jsIds.every((id, i) => id === rpcIds[i]);
    const totalMatch = (total ?? 0) === jsIds.length;
    if (idsMatch && totalMatch) {
      pass(`filter="${filter}": ${jsIds.length} rows, order + total match`);
    } else {
      if (!totalMatch) fail(`filter="${filter}" total_count`, jsIds.length, total);
      if (!idsMatch) fail(`filter="${filter}" id set/order`, jsIds.slice(0, 10), rpcIds.slice(0, 10));
    }
  }

  // ---- 3. Search ----
  console.log("\nSearch (search_lead_inbox vs JS matchesSearch):");
  let query = searchArg;
  if (!query) {
    // Pick a real token: first word of the first non-deleted lead name.
    const sample = normalized.find((l) => !l.deleted_at && l.name);
    query = sample?.name?.trim().split(/\s+/)[0] ?? "a";
  }
  const jsSearch = filterLeads(union, "all", query)
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id.localeCompare(a.id))
    .map((l) => l.id);
  const rpcSearch = [];
  let searchTotal = null;
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const { data, error } = await supabase.rpc("search_lead_inbox", {
      p_account: accountId,
      p_filter: "all",
      p_query: query,
      p_limit: PAGE_LIMIT,
      p_offset: offset,
    });
    if (error) throw error;
    if (!data || data.length === 0) break;
    if (searchTotal === null) searchTotal = Number(data[0].total_count);
    rpcSearch.push(...data.map((r) => r.id));
    if (data.length < PAGE_LIMIT) break;
  }
  const searchMatch =
    jsSearch.length === rpcSearch.length && jsSearch.every((id, i) => id === rpcSearch[i]);
  if (searchMatch && (searchTotal ?? 0) === jsSearch.length) {
    pass(`search "${query}": ${jsSearch.length} rows match`);
  } else {
    fail(`search "${query}"`, jsSearch.slice(0, 10), rpcSearch.slice(0, 10));
  }

  // ---- 4. Wildcard-escaping sanity: a literal % should not match everything ----
  console.log("\nWildcard escaping (literal % is not treated as a wildcard):");
  const { data: pctData, error: pctErr } = await supabase.rpc("search_lead_inbox", {
    p_account: accountId,
    p_filter: "all",
    p_query: "%",
    p_limit: PAGE_LIMIT,
    p_offset: 0,
  });
  if (pctErr) throw pctErr;
  const jsPct = filterLeads(union, "all", "%").length;
  const rpcPct = pctData?.length ? Number(pctData[0].total_count) : 0;
  if (jsPct === rpcPct) pass(`search "%": ${rpcPct} rows (literal, not wildcard)`);
  else fail(`search "%"`, jsPct, rpcPct);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
