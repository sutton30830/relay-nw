"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { contactRequest, type ContactDetails } from "@/lib/contact-client";
import { ContactEditor } from "./_components/contact-editor";

import { ContactImporter } from "./_components/contact-importer";

const PAGE_SIZE = 20;
export function ContactsSection({ readOnly }: { readOnly: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<ContactDetails[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [edit, setEdit] = useState<ContactDetails | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError("");
    const params = new URLSearchParams({ q: search, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    void contactRequest<{ contacts: ContactDetails[]; total: number }>(`/api/contacts?${params}`, "GET", undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (page > 0 && page * PAGE_SIZE >= result.total) { setPage(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1)); return; }
      setRows(result.contacts); setTotal(result.total);
    }).catch((cause) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Could not load contacts.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, page, revision]);

  useEffect(() => {
    const refresh = () => { if (!edit && !adding) setRevision((value) => value + 1); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [edit, adding]);

  function refresh(message: string) {
    setEdit(null); setNotice(message); setRevision((value) => value + 1); router.refresh();
    heading.current?.focus();
  }

  async function add() {
    if (busy) return;
    setBusy(true); setSaveError("");
    try {
      const result = await contactRequest<{ contact: ContactDetails; created: boolean }>("/api/contacts", "POST", { phone, displayName: name });
      setAdding(false); setPhone(""); setName(""); setQuery(""); setSearch(""); setPage(0);
      refresh(result.created ? "Contact saved. Automatic texts are off; classification is Unclassified." : "This number is already saved. Its classification and automatic-text preference were kept.");
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Could not confirm the save. Reload contacts before retrying."); }
    finally { setBusy(false); }
  }

  return <section id="contacts" className="panel settings-section contacts-section" aria-labelledby="contacts-heading">
    <div className="contact-heading"><div><h2 id="contacts-heading" ref={heading} tabIndex={-1}>Contacts</h2><p className="settings-section__meta">Save numbers you recognize to turn off automatic missed-call texts. Calls still reach your inbox unless you mark the contact Personal.</p></div>
      {!readOnly ? <button className="btn btn-secondary btn-sm" type="button" disabled={Boolean(edit) || busy || importOpen} aria-expanded={adding} onClick={() => { setAdding(!adding); setSaveError(""); }}>Add contact</button> : null}</div>
    <p className="settings-section__meta"><Link href="/leads?filter=personal">View Personal calls</Link>{readOnly ? " · View-only access. An owner or admin can manage contacts." : " · Removing a contact keeps call and message history."}</p>
    {!readOnly && !adding && !edit ? <ContactImporter onOpenChange={setImportOpen} onChanged={() => { setRevision((value) => value + 1); router.refresh(); }} /> : null}
    {notice ? <p className="contact-notice" role="status">{notice}</p> : null}
    {adding && !readOnly ? <form className="contact-editor" aria-label="Add contact" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <fieldset disabled={busy}><label className="form-field"><span>Phone number</span><input autoFocus required type="tel" className="field" maxLength={100} value={phone} placeholder="(206) 555-0101" onChange={(event) => setPhone(event.target.value)} /><span className="form-field__hint">For numbers outside the US or Canada, include + and the country code. No extensions.</span></label>
        <label className="form-field"><span>Name (optional)</span><input className="field" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <p className="settings-section__meta">New contacts are Unclassified with automatic texts off. Saving does not create a lead or send a message.</p>
        <div className="contact-actions"><button className="btn btn-primary btn-sm" type="submit">{busy ? "Saving…" : "Save new contact"}</button><button className="btn btn-secondary btn-sm" type="button" onClick={() => setAdding(false)}>Cancel</button></div></fieldset>
      {saveError ? <p className="convo__error" role="alert">{saveError}</p> : null}
    </form> : null}
    <form className="contact-search" role="search" aria-label="Search contacts" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); setPage(0); }}>
      <label className="form-field"><span>Search contacts</span><input className="field" type="search" maxLength={120} placeholder="Name or phone number" disabled={Boolean(edit) || busy} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button className="btn btn-secondary btn-sm" type="submit" disabled={Boolean(edit) || busy}>Search</button>
    </form>
    <div aria-busy={loading}>
      {loading ? <p role="status">Loading contacts…</p> : loadError ? <div role="alert"><p>{loadError}</p><button className="btn btn-secondary btn-sm" type="button" onClick={() => setRevision((value) => value + 1)}>Retry loading contacts</button></div> : <>
        <p className="settings-section__meta">{total === 0 ? search ? "No contacts match this search." : "No saved contacts yet." : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} contacts`}</p>
        <ul className="contact-list">{rows.map((contact) => <li key={contact.id}>
          <div className="contact-row"><div><strong>{contact.display_name || contact.phone}</strong>{contact.display_name ? <span className="contact-phone">{contact.phone}</span> : null}<span className="contact-meta">{contact.classification === "unclassified" ? "Unclassified" : contact.classification === "personal" ? "Personal" : "Customer"} · Automatic texts {contact.auto_sms_policy === "standard" ? "eligible" : "off"}</span></div>
            {!readOnly ? <button className="btn btn-secondary btn-sm" type="button" disabled={Boolean(edit) || adding || importOpen} onClick={() => { setEdit(contact); setNotice(""); }} aria-label={`Edit ${contact.display_name || contact.phone}`}>Edit</button> : null}</div>
          {edit?.id === contact.id && !readOnly ? <ContactEditor key={`${edit.id}:${edit.version}`} contact={edit} onCancel={() => { setEdit(null); heading.current?.focus(); }} onSaved={(saved) => refresh(saved ? "Contact updated. Retained calls now follow its classification; past text outcomes are unchanged." : "Contact removed. Future calls follow ordinary texting rules; no past texts will be sent.")} onStale={() => refresh("Reloaded current contacts. Review the latest preferences before editing again.")} /> : null}
        </li>)}</ul>
        {total > PAGE_SIZE ? <nav className="contact-actions" aria-label="Contact pages"><button className="btn btn-secondary btn-sm" disabled={page === 0 || Boolean(edit) || adding} onClick={() => setPage(page - 1)}>Previous contacts</button><span>Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}</span><button className="btn btn-secondary btn-sm" disabled={(page + 1) * PAGE_SIZE >= total || Boolean(edit) || adding} onClick={() => setPage(page + 1)}>Next contacts</button></nav> : null}
      </>}
    </div>
  </section>;
}
