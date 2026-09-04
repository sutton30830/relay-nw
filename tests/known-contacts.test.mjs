import assert from "node:assert/strict";
import test from "node:test";
import { loadContactModule, loadContactService, phoneFixtures } from "./helpers/contacts.mjs";
const pure = await loadContactModule("lib/contacts.ts");
const A = "a1111111-1111-4111-8111-111111111111";
const B = "b2222222-2222-4222-8222-222222222222";
const ID = "c3333333-3333-4333-8333-333333333333";

test("historical phone keys reject suffix/name matching and preserve explicit country codes", () => {
  for (const [raw, expected] of phoneFixtures) assert.equal(pure.knownContactPhoneKey(raw), expected, String(raw));
});
test("new numbers require full numbering-plan validation and no extensions or extracted text", () => {
  assert.equal(pure.parseContactPhone("(206) 555-0101"), "+12065550101");
  assert.equal(pure.parseContactPhone("020 7946 0018", "GB"), "+442079460018");
  assert.equal(pure.parseContactPhone("+44 20 7946 0018"), "+442079460018");
  for (const input of ["1234567890", "+19995550101", "2065550101 ext 2", "Call 2065550101", "+1206555010123456", "anonymous", "++12065550101"]) assert.throws(() => pure.parseContactPhone(input), { status: 400 });
  assert.throws(() => pure.parseContactPhone("2065550101", "ZZ"), { status: 400 });
});
test("merge validates every row, deduplicates canonical phones and never submits an update", async () => {
  const calls = [];
  const { service } = await loadContactService({ rpc: async (...args) => { calls.push(args); return { data: [], error: null }; } });
  await service.mergeKnownContacts(A, [{ phone: "2065550101" }, { phone: "+1 (206) 555-0101", displayName: " Dave " }, { phone: "+442079460018", classification: "personal" }], { source: "csv" });
  assert.equal(calls[0][0], "merge_known_contacts");
  assert.deepEqual(calls[0][1].p_entries, [
    { phone: "+12065550101", display_name: "Dave", classification: "unclassified", source: "csv" },
    { phone: "+442079460018", display_name: null, classification: "personal", source: "csv" },
  ]);
  assert.equal(calls[0][1].p_account_id, A);
  for (const entries of [[{ phone: "2065550101", autoSmsPolicy: "standard" }], [{ phone: "2065550101" }, { phone: "invalid" }], Array(251).fill({ phone: "2065550101" })]) {
    await assert.rejects(service.mergeKnownContacts(A, entries, { source: "csv" }), { status: 400 });
  }
  assert.equal(calls.length, 1);
});
test("lookup batches exact canonical keys under the required tenant predicate", async () => {
  const queries = [];
  const { service } = await loadContactService({ from(table) {
    const query = { table }; queries.push(query);
    const builder = { select() { return builder; }, eq(key,value) { query[key] = value; return builder; }, in(key,value) { query[key] = value; return Promise.resolve({ data: [{ phone: value[0], account_id: A }], error: null }); } };
    return builder;
  } });
  const map = await service.getKnownContactsByPhones(A, ["2065550101", "+12065550101", "Mom 2065550101"]);
  assert.equal(map.size, 1);
  assert.deepEqual(queries, [{ table: "account_known_contacts", account_id: A, phone: ["+12065550101"] }]);
});
test("writes reject immutable fields, invalid policy/version, and map storage failures safely", async () => {
  const calls = [];
  const { service } = await loadContactService({ rpc: async (...args) => { calls.push(args); return { error: { code: "40001", message: "private contact details" } }; } });
  await assert.rejects(service.updateKnownContact(A, ID, { version: 1, phone: "2065550101" }), { status: 400 });
  await assert.rejects(service.updateKnownContact(A, ID, { version: "1", displayName: "Name" }), { status: 400 });
  await assert.rejects(service.updateKnownContact(A, ID, { version: 1, autoSmsPolicy: "enabled" }), { status: 400 });
  await assert.rejects(service.updateKnownContact(B, ID, { version: 1, displayName: null }), { status: 409 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].p_account_id, B);
  const unavailable = (await loadContactService({ rpc: async () => { throw new Error("sensitive details"); } })).service;
  await assert.rejects(unavailable.deleteKnownContact(A, ID, 1), { status: 503, message: "Contact storage is unavailable" });
  const placeholder = (await loadContactService({}, true)).service;
  await assert.rejects(placeholder.createKnownContact(A, { phone: "2065550101" }), { status: 503 });
});
test("lead action derives caller from the scoped lead and does not accept supplied numbers", async () => {
  const filters = []; const calls = [];
  const builder = { select() { return builder; }, eq(k,v) { filters.push([k,v]); return builder; }, maybeSingle: async () => ({ data: { phone: "2065550101" } }) };
  const { service } = await loadContactService({ from: () => builder, rpc: async (...args) => { calls.push(args); return { data: {} }; } });
  await service.setLeadContactPreference(A, ID, { action: "mark_personal", version: 2, contactId: ID });
  assert.deepEqual(filters, [["account_id", A], ["id", ID]]);
  assert.deepEqual(calls[0][1], { p_account_id: A, p_lead_id: ID, p_phone: "+12065550101", p_action: "mark_personal", p_version: 2, p_contact_id: ID });
  await assert.rejects(service.setLeadContactPreference(A, ID, { action: "mark_personal", phone: "+12065550102" }), { status: 400 });
});

async function routes({ role = "owner", failure = null } = {}) {
  const calls = []; const invalidations = [];
  const guards = {
    requireAccountUserJson: async () => role === "none" ? { response: Response.json({}, { status: 401 }) } : { session: { accountId: A } },
    requireWriteAccessJson: async () => ["owner", "admin"].includes(role) ? { session: { accountId: A } } : { response: Response.json({}, { status: role === "none" ? 401 : 403 }) },
  };
  const api = await loadContactModule("lib/contact-api.ts", { "@/lib/contacts": pure, "next/cache": { revalidatePath: (path) => invalidations.push(path) } });
  const service = Object.fromEntries(["listKnownContacts", "createKnownContact", "updateKnownContact", "deleteKnownContact", "setLeadContactPreference"].map((name) => [name, async (...args) => { calls.push([name, ...args]); if (failure) throw failure; return { created: true }; }]));
  const mocks = { "@/lib/auth": guards, "@/lib/contacts": pure, "@/lib/contact-api": api, "@/lib/supabase/contacts": service };
  return { collection: await loadContactModule("app/api/contacts/route.ts", mocks), detail: await loadContactModule("app/api/contacts/[id]/route.ts", mocks), lead: await loadContactModule("app/api/leads/[id]/contact/route.ts", mocks), calls, invalidations };
}
const req = (method, body) => new Request("http://localhost/api/contacts", { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const ctx = { params: Promise.resolve({ id: ID }) };
for (const role of ["none", "viewer", "owner", "admin"]) test(`contact routes honor ${role} access on every method`, async () => {
  const r = await routes({ role });
  assert.equal((await r.collection.GET(req("GET"))).status, role === "none" ? 401 : 200);
  for (const [method, handler, body] of [["POST", r.collection.POST, { phone: "2065550101" }], ["PATCH", r.detail.PATCH, { version: 1, displayName: null }], ["DELETE", r.detail.DELETE, { version: 1 }], ["POST", r.lead.POST, { action: "mark_personal" }]]) {
    const response = await handler(req(method, body), ctx);
    assert.equal(response.status, role === "none" ? 401 : role === "viewer" ? 403 : handler === r.collection.POST ? 201 : 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.ok(r.calls.every((call) => call[1] === A));
  if (role === "none") assert.equal(r.calls.length, 0);
  if (role === "viewer") assert.equal(r.calls.length, 1);
});
test("API rejects mass assignment, invalid JSON, oversized streams and exposes only safe errors", async () => {
  const r = await routes();
  assert.equal((await r.collection.POST(req("POST", { phone: "2065550101", accountId: B }))).status, 400);
  assert.equal((await r.collection.POST(new Request("http://localhost", { method: "POST", body: "{" }))).status, 400);
  assert.equal((await r.collection.POST(req("POST", { phone: "2".repeat(17000) }))).status, 413);
  assert.equal(r.calls.length, 0);
  for (const status of [404, 409, 503]) {
    const failing = await routes({ failure: new pure.ContactError(status, "Safe error") });
    assert.equal((await failing.detail.DELETE(req("DELETE", { version: 1 }), ctx)).status, status);
    assert.equal(failing.invalidations.length, 0);
  }
});

test("account export exhausts contact pages and deletion preview counts all contacts", async () => {
  const contacts = Array.from({ length: 1203 }, (_, i) => ({ id: String(i).padStart(5,"0"), account_id: A }));
  const queries = [];
  const supabaseAdmin = { storage: { from: () => ({ list: async () => ({ data: [] }) }) }, from(table) {
    const query = { table }; queries.push(query);
    const builder = { select(_, options) { query.head = options?.head; return builder; }, eq(k,v) { query[k] = v; return builder; }, not() { return builder; }, order() { return builder; }, limit(n) { query.limit = n; return builder; }, gt(k,v) { query.after = v; return builder; }, maybeSingle: async () => ({ data: { id: A } }), then(resolve) {
      assert.equal(query.account_id ?? query.target_account_id, A);
      const data = table === "account_known_contacts" ? contacts.filter((c) => !query.after || c.id > query.after).slice(0, Math.min(query.limit ?? 500, 500)) : [];
      return Promise.resolve({ data, count: table === "account_known_contacts" ? contacts.length : 0 }).then(resolve);
    } }; return builder;
  } };
  const retention = await loadContactModule("lib/supabase/retention.ts", { "./client": { supabaseAdmin, throwIfSupabaseError: (e) => { if(e) throw e; } }, "./tenant": { assertAccountId: (v) => v } });
  const exported = await retention.exportAccountData(A);
  assert.equal(exported.data.account_known_contacts.length, 1203);
  assert.equal(new Set(exported.data.account_known_contacts.map((c) => c.id)).size, 1203);
  assert.equal(queries.filter((q) => q.table === "account_known_contacts").length, 4);
  const preview = await retention.previewAccountDeletion(A);
  assert.equal(preview.databaseRows.account_known_contacts, 1203);
});
