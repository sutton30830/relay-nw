import assert from "node:assert/strict";
import test from "node:test";
import { loadContactModule } from "./helpers/contacts.mjs";
import { readFile } from "node:fs/promises";

const client = await loadContactModule("lib/contact-client.ts");

test("contact edit cannot enable Personal or unclassified contacts, and requires an explicit customer preference", () => {
  for (const classification of ["personal", "unclassified"]) {
    assert.equal(client.contactEditPatch(8, " Mom ", classification, "standard").autoSmsPolicy, "suppress");
  }
  assert.deepEqual(client.contactEditPatch(8, " Dave ", "customer", "standard"), {
    version: 8, displayName: "Dave", classification: "customer", autoSmsPolicy: "standard",
  });
  assert.equal(client.contactEditPatch(9, "", "customer", "suppress").autoSmsPolicy, "suppress");
});

test("confirmed contact changes alter only contact metadata, never the saved lead name or delivery outcome", () => {
  const original = { name: "Owner name", sms_status: "skipped_known_contact", phone: "+12065550101" };
  const contact = { id: "contact", version: 3, display_name: "Imported name", classification: "personal", auto_sms_policy: "suppress", phone: original.phone };
  const updated = { ...original, ...client.contactLeadFields(contact) };
  assert.equal(updated.name, original.name); assert.equal(updated.sms_status, original.sms_status);
  assert.equal(updated.is_personal, true); assert.deepEqual(client.contactFromLead(updated), contact);
  const removed = { ...updated, ...client.contactLeadFields(null) };
  assert.equal(removed.is_personal, false); assert.equal(removed.contact_name, null);
  assert.equal(removed.sms_status, "skipped_known_contact"); assert.equal(client.contactFromLead(removed), null);
  assert.equal(client.contactFromLead({ ...updated, contact_version: null }), null);
});

test("Text them anyway prepares the account template and booking link without replacing an existing draft", () => {
  assert.equal(client.contactReplyDraft("Unfinished reply", ["Account template"], "https://example.invalid/book"), "Unfinished reply");
  assert.equal(client.contactReplyDraft("", ["", "Account template"], "https://example.invalid/book"), "Account template\n\nBook here: https://example.invalid/book");
  assert.equal(client.contactReplyDraft("", ["Book: https://example.invalid/book"], "https://example.invalid/book"), "Book: https://example.invalid/book");
  assert.equal(client.contactReplyDraft("", [], null), "Thanks for calling. How can I help?");
});

test("contact client preserves version conflicts and forwards cancellation without caching tenant reads", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return Response.json({ error: "Contact changed; reload and try again" }, { status: 409 });
    };
    await assert.rejects(client.contactRequest("/api/contacts/c", "PATCH", { version: 5 }), (error) => error.status === 409 && /reload/.test(error.message));
    assert.deepEqual(JSON.parse(requests[0].options.body), { version: 5 });
    globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ contacts: [], total: 0 }); };
    const controller = new AbortController();
    assert.deepEqual(await client.contactRequest("/api/contacts?q=Mom", "GET", undefined, controller.signal), { contacts: [], total: 0 });
    assert.equal(requests[1].options.signal, controller.signal); assert.equal(requests[1].options.cache, "no-store");
    assert.equal(requests[1].options.body, undefined);
  } finally { globalThis.fetch = previousFetch; }
});

test("Settings and lead controls expose role-safe, recoverable interaction states", async () => {
  const [settings, editor, controls, conversation, drawer] = await Promise.all([
    readFile(new URL("../app/settings/contacts-section.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/_components/contact-editor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/leads/_components/lead-contact-controls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/leads/[id]/conversation-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/leads/_components/lead-drawer.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /readOnly \? " · View-only access/);
  assert.match(settings, /Loading contacts…/); assert.match(settings, /No contacts match this search/);
  assert.match(settings, /Retry loading contacts/); assert.match(settings, /page \* PAGE_SIZE >= result\.total/);
  assert.match(editor, /classification === "customer"/); assert.match(editor, /Send an automatic text after a missed call/);
  assert.match(editor, /role="alert"/); assert.match(editor, /Reload current contact/);
  assert.match(controls, /Edit contact preferences/); assert.match(controls, /Turn off automatic texts/); assert.match(controls, /Mark as personal/);
  assert.match(controls, /aria-expanded=\{editing\}/);
  
  
  assert.match(editor, /Contact type/);
  for (const surface of [conversation, drawer]) {
    assert.match(surface, /Not auto-texted: known contact/); assert.match(surface, /Text them anyway/);
    assert.match(surface, /contactReplyDraft/); assert.match(surface, /reviewDraft/);
  }
  assert.match(conversation, /!reviewDraft && !isTouch && event\.key === "Enter"/);
  assert.match(drawer, /!reviewDraft && event\.key === "Enter"/);
});
