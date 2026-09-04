"use client";

import { useState } from "react";
import type { ContactClassification, ContactSmsPolicy } from "@/lib/supabase/types";
import { contactEditPatch, contactRequest, ContactRequestError, CONTACT_ENABLE_COPY, CONTACT_REMOVAL_COPY, type ContactDetails } from "@/lib/contact-client";

export function ContactEditor({ contact, onSaved, onCancel, onStale }: {
  contact: ContactDetails;
  onSaved: (contact: ContactDetails | null) => void;
  onCancel: () => void;
  onStale: () => void;
}) {
  const [name, setName] = useState(contact.display_name ?? "");
  const [classification, setClassification] = useState<ContactClassification>(contact.classification);
  const [policy, setPolicy] = useState<ContactSmsPolicy>(contact.auto_sms_policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [stale, setStale] = useState(false);

  async function save(remove = false) {
    if (busy || stale) return;
    setBusy(true); setError("");
    try {
      const result = await contactRequest<{ contact: ContactDetails }>(`/api/contacts/${contact.id}`, remove ? "DELETE" : "PATCH",
        remove ? { version: contact.version } : contactEditPatch(contact.version, name, classification, policy));
      onSaved(remove ? null : result.contact);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm the change. Reload before trying again.");
      if (!(cause instanceof ContactRequestError) || cause.status === 409 || cause.status === 404) setStale(true);
    } finally { setBusy(false); }
  }

  return <form className="contact-editor" aria-label={`Edit contact ${contact.phone}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy || stale}>
      <label className="form-field"><span>Name</span><input autoFocus className="field" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="form-field"><span>Classification</span><select className="field" value={classification} onChange={(event) => {
        setClassification(event.target.value as ContactClassification); setPolicy("suppress");
      }}><option value="unclassified">Unclassified</option><option value="customer">Customer</option><option value="personal">Personal</option></select></label>
      <p className="settings-section__meta">{classification === "personal"
        ? "Retained calls move to Personal and stay out of business Reports and recaps. History is kept. Automatic texts stay off."
        : "Calls stay in the business inbox and Reports. Changing classification does not restore calls in Trash."}</p>
      {classification === "customer" ? <label className="contact-checkbox"><input type="checkbox" checked={policy === "standard"} onChange={(event) => setPolicy(event.target.checked ? "standard" : "suppress")} /> Allow automatic missed-call texts</label>
        : <p className="settings-section__meta">Automatic missed-call texts are off.</p>}
      {classification === "customer" ? <p className="settings-section__meta">{CONTACT_ENABLE_COPY}</p> : null}
      <div className="contact-actions"><button className="btn btn-primary btn-sm" type="submit">{busy ? "Saving…" : "Save contact"}</button><button className="btn btn-secondary btn-sm" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRemoving(!removing)} aria-expanded={removing}>Remove contact</button></div>
      {removing ? <div className="contact-removal"><p>{CONTACT_REMOVAL_COPY}</p><button className="btn btn-secondary btn-sm" type="button" onClick={() => void save(true)}>Confirm removal</button></div> : null}
    </fieldset>
    {error ? <p className="convo__error" role="alert">{error}</p> : null}
    {stale ? <button className="btn btn-secondary btn-sm" type="button" onClick={onStale}>Reload current contact</button> : null}
  </form>;
}
