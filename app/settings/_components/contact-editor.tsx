"use client";

import { useState } from "react";
import type { ContactClassification, ContactSmsPolicy } from "@/lib/supabase/types";
import { contactEditPatch, contactRequest, ContactRequestError, CONTACT_REMOVAL_COPY, type ContactDetails } from "@/lib/contact-client";

export function ContactEditor({ contact, phone, onSaved, onCancel, onStale }: {
  contact: ContactDetails | null;
  phone?: string;
  onSaved: (contact: ContactDetails | null) => void;
  onCancel: () => void;
  onStale: () => void;
}) {
  const [name, setName] = useState(contact?.display_name ?? "");
  const [classification, setClassification] = useState<ContactClassification>(contact?.classification ?? "unclassified");
  const [policy, setPolicy] = useState<ContactSmsPolicy>(contact?.auto_sms_policy ?? "suppress");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [stale, setStale] = useState(false);

  async function save(remove = false) {
    if (busy || stale) return;
    setBusy(true); setError("");
    try {
      const result = contact
        ? await contactRequest<{ contact: ContactDetails }>(`/api/contacts/${contact.id}`, remove ? "DELETE" : "PATCH",
          remove ? { version: contact.version } : contactEditPatch(contact.version, name, classification, policy))
        : await contactRequest<{ contact: ContactDetails }>("/api/contacts", "POST", { phone, displayName: name, classification });
      onSaved(remove ? null : result.contact);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm the change. Reload before trying again.");
      if (!(cause instanceof ContactRequestError) || cause.status === 409 || cause.status === 404) setStale(true);
    } finally { setBusy(false); }
  }

  return <form className="contact-editor" aria-label={`${contact ? "Edit" : "Save"} contact ${contact?.phone ?? phone}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy || stale}>
      <label className="form-field"><span>Name (optional)</span><input autoFocus className="field" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="form-field"><span>Contact type</span><select className="field" value={classification} onChange={(event) => {
        setClassification(event.target.value as ContactClassification); setPolicy("suppress");
      }}><option value="unclassified">Unclassified</option><option value="customer">Customer</option><option value="personal">Personal</option></select></label>
      <p className="settings-section__meta">{classification === "personal"
        ? "Calls appear in Personal and stay out of business Reports. All history is kept."
        : "Calls stay in your business inbox and Reports."}</p>
      <div className="contact-texting-preference">
        <p className="t-eyebrow">Automatic missed-call texts</p>
        {classification === "customer" && contact ? <>
          <label className="contact-checkbox"><input type="checkbox" checked={policy === "standard"} onChange={(event) => setPolicy(event.target.checked ? "standard" : "suppress")} /> Send an automatic text after a missed call</label>
          <p className="settings-section__meta">Turning this off keeps the contact in your business inbox. Account texting settings and recipient opt-outs still apply.</p>
        </> : <p className="settings-section__meta">{classification === "personal" ? "Off for Personal contacts." : classification === "unclassified" ? "Off until you choose Customer and enable texting." : "Off for new contacts. Save first, then edit to enable texting."}</p>}
        <p className="settings-section__meta">You can still reply manually when texting is available. Past skipped texts are never sent.</p>
      </div>
      <div className="contact-actions"><button className="btn btn-primary btn-sm" type="submit">{busy ? "Saving…" : "Save contact"}</button><button className="btn btn-secondary btn-sm" type="button" onClick={onCancel}>Cancel</button>
        {contact ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRemoving(!removing)} aria-expanded={removing}>Remove contact</button> : null}</div>
      {removing ? <div className="contact-removal"><p>{CONTACT_REMOVAL_COPY}</p><button className="btn btn-secondary btn-sm" type="button" onClick={() => void save(true)}>Confirm removal</button></div> : null}
    </fieldset>
    {error ? <p className="convo__error" role="alert">{error}</p> : null}
    {stale ? <button className="btn btn-secondary btn-sm" type="button" onClick={onStale}>Reload current contact</button> : null}
  </form>;
}
