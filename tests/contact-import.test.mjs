import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadContactModule, loadContactService } from "./helpers/contacts.mjs";
const pure = await loadContactModule("lib/contacts.ts");
const parser = await loadContactModule("lib/contact-import.ts", { "./contacts": pure });
const csv = await readFile(new URL("./fixtures/contacts/google.csv", import.meta.url), "utf8");
const vcard = await readFile(new URL("./fixtures/contacts/apple.vcf", import.meta.url), "utf8");
test("Google CSV supports quoting, ignored multiline notes, multiple phone columns, duplicates and invalid extensions", () => {
  const rows = parser.readCsv(csv); assert.equal(rows.length, 4); assert.equal(rows[1][7], 'A quoted "note"\nwith another line');
  const mapping = parser.suggestMapping(rows[0]); assert.deepEqual(mapping, { names: [0], phones: [4, 6] });
  const preview = parser.previewEntries(parser.csvEntries(rows, mapping), "US");
  assert.equal(preview.length, 4); assert.equal(preview[0].displayName, "Doe, Jane");
  assert.equal(preview[1].normalized, "+442079460018"); assert.equal(preview[2].duplicateOf, 0); assert.equal(preview[2].conflict, true); assert.match(preview[3].error, /phone/i);
});
test("Apple vCard supports grouped properties, folded phones, escaping, and v4 telephone URIs", () => {
  const rows = parser.previewEntries(parser.vcardEntries(vcard), "US");
  assert.equal(rows.length, 3); assert.deepEqual(rows.map((r) => r.normalized), ["+12065550101", "+442079460018", "+12065550102"]);
  assert.equal(rows[2].displayName, "Smith, Pat; Jr."); assert.ok(rows.every((r) => !r.error));
});
test("malformed formats, unsupported encodings, ambiguous phones, extensions, and limits fail explicitly", () => {
  for (const text of ['Name,Phone\n"unclosed,123', 'Name,Phone\n"a"oops,123', 'Name,Phone\na"b,123']) assert.throws(() => parser.readCsv(text), /quot/i);
  assert.throws(() => parser.vcardEntries("BEGIN:VCARD\nVERSION:2.1\nEND:VCARD"), /3.0/);
  assert.throws(() => parser.vcardEntries("BEGIN:VCARD\nVERSION:3.0"), /Unclosed/);
  const unsupported = parser.vcardEntries("BEGIN:VCARD\nVERSION:3.0\nFN;ENCODING=QUOTED-PRINTABLE:=50at\nTEL:+12065550101\nEND:VCARD");
  assert.ok(parser.previewEntries(unsupported, "US")[0].error);
  assert.throws(() => parser.previewEntries(Array(2001).fill({ phone: "+12065550101" }), "US"), /2,000/);
  assert.throws(() => parser.readCsv("Phone\n" + "123\n".repeat(2001)), /2,000/);
  const numbers = ["5550101", "02079460018", "tel:+12065550101;ext=2", "=SUM(1,2)"];
  assert.ok(parser.previewEntries(numbers.map((phone) => ({ phone, displayName: null })), "US").every((r) => r.error));
  assert.equal(parser.previewEntries([{ phone: "02079460018", displayName: null }], "GB")[0].normalized, "+442079460018");
});
test("mapping is explicit, supports multi-values, treats untrusted names as data and flags multiline names", () => {
  assert.deepEqual(parser.suggestMapping(["Contact", "Number A", "Number B"]), { names: [], phones: [] });
  const rows = parser.readCsv('Contact,Number A,Number B\n<img src=x onerror=alert(1)>,+12065550101 ::: +12065550102,+442079460018');
  const preview = parser.previewEntries(parser.csvEntries(rows, { names: [0], phones: [1, 2] }), "US");
  assert.equal(preview.length, 3); assert.equal(preview[0].displayName, "<img src=x onerror=alert(1)>");
  assert.ok(parser.previewEntries([{ phone: "+12065550101", displayName: "two\nlines" }], "US")[0].error);
});
const account = "11111111-1111-4111-8111-111111111111";
async function routeHarness({ forbidden = false, failAfterCommit = false } = {}) {
  const saved = new Map(); let failed = false; let scope = account;
  const { service } = await loadContactService({
    rpc: async (name, args) => {
      assert.equal(name, "merge_known_contacts");
      const results = args.p_entries.map((entry) => {
        const key = `${args.p_account_id}:${entry.phone}`; const old = saved.get(key);
        const contact = old || { ...entry, auto_sms_policy: "suppress", account_id: args.p_account_id };
        saved.set(key, contact); return { contact, created: !old };
      });
      if (failAfterCommit && !failed) { failed = true; throw new Error("response lost"); }
      return { data: results, error: null };
    },
  });
  const route = await loadContactModule("app/api/contacts/import/route.ts", {
    "@/lib/auth": { requireWriteAccessJson: async () => forbidden ? { response: Response.json({}, { status: 403 }) } : { session: { accountId: scope } } },
    "@/lib/contacts": pure,
    "@/lib/supabase/contacts": service,
    "@/lib/contact-api": {
      readContactBody: async (r, fields) => pure.contactObject(await r.json(), fields),
      privateAuthResponse: (r) => r, privateContactResponse: (v) => Response.json(v), invalidateContactReads: () => {},
      contactApiError: (e) => Response.json({ error: e.message }, { status: e.status || 503 }),
    },
  });
  return { saved, setScope: (s) => { scope = s; }, post: (entries, rest = {}) => route.POST(new Request("http://localhost/api/contacts/import", { method: "POST", body: JSON.stringify({ mode: "import", country: "US", source: "csv", entries, ...rest }) })) };
}
test("import route uses scoped shared merge, reports invalid/duplicate outcomes and preserves owner decisions across formats", async () => {
  const h = await routeHarness(); const entry = { phone: "2065550101", displayName: "Import" };
  let response = await h.post([entry, entry, { phone: "ambiguous" }]);
  let body = await response.json(); assert.equal(body.added, 1); assert.equal(body.duplicates, 1); assert.equal(body.rejected.length, 1);
  const stored = h.saved.get(`${account}:+12065550101`); Object.assign(stored, { display_name: "Owner", classification: "customer", auto_sms_policy: "standard" });
  response = await h.post([{ ...entry, classification: "personal" }], { source: "vcard" }); body = await response.json(); assert.equal(body.existing, 1); assert.equal(stored.display_name, "Owner"); assert.equal(stored.auto_sms_policy, "standard"); assert.equal(stored.classification, "customer");
  h.setScope("22222222-2222-4222-8222-222222222222"); assert.equal((await (await h.post([entry])).json()).added, 1); assert.equal(h.saved.size, 2);
  assert.equal((await h.post([entry], { accountId: account })).status, 400);
});
test("lost response retry is safe and reports already committed records as existing", async () => {
  const h = await routeHarness({ failAfterCommit: true }); const entries = [{ phone: "+12065550101", displayName: "Pat", classification: "personal" }];
  assert.equal((await h.post(entries)).status, 503);
  const result = await (await h.post(entries)).json(); assert.equal(result.added, 0); assert.equal(result.existing, 1); assert.equal(h.saved.size, 1);
});
test("viewer denied and import cannot enable SMS or accept oversized batches", async () => {
  const denied = await routeHarness({ forbidden: true }); assert.equal((await denied.post([{ phone: "+12065550101" }])).status, 403); assert.equal(denied.saved.size, 0);
  const h = await routeHarness(); assert.equal((await h.post(Array(251).fill({ phone: "+12065550101" }))).status, 400);
  const result = await (await h.post([{ phone: "+12065550101", classification: "customer" }, { phone: "+12065550102", autoSmsPolicy: "standard" }])).json(); assert.equal(result.rejected.length, 2); assert.equal(h.saved.size, 0);
});

test("streamed import body enforces actual byte limits without trusting content-length", async () => {
  const api = await loadContactModule("lib/contact-api.ts", { "next/cache": { revalidatePath: () => {} }, "@/lib/contacts": pure });
  const request = (body) => new Request("http://localhost", { method: "POST", body });
  await assert.rejects(api.readContactBody(request(JSON.stringify({ entries: "a".repeat(262144) })), ["entries"], 256 * 1024), (e) => e.status === 413);
  assert.deepEqual(await api.readContactBody(request('{"entries":[]}'), ["entries"], 256 * 1024), { entries: [] });
  await assert.rejects(api.readContactBody(request('{"accountId":"other"}'), ["entries"], 256 * 1024), /fields/);
});

test("telemetry initialization excludes address-book request/response and database payloads", async () => {
  for (const file of ["instrumentation-client.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
    let config;
    await loadContactModule(file, { "@sentry/nextjs": { init: (options) => { config = options; }, replayIntegration: () => ({}), captureRouterTransitionStart: () => {} } });
    assert.deepEqual(config.dataCollection.httpBodies, []);
    assert.equal(config.dataCollection.databaseQueryData, false);
  }
  const ui = await readFile(new URL("../app/settings/_components/contact-importer.tsx", import.meta.url), "utf8");
  assert.match(ui, /contact-editor sentry-block/);
});
