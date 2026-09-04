"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lead } from "@/lib/supabase/types";
import { contactFromLead, contactEditPatch, contactRequest, type ContactDetails } from "@/lib/contact-client";
import { ContactEditor } from "@/app/settings/_components/contact-editor";

export function LeadContactControls({ lead, readOnly, onChanged }: {
  lead: Lead; readOnly: boolean; onChanged: (contact: ContactDetails | null) => void;
}) {
  const router = useRouter();
  const [contact, setContact] = useState(() => contactFromLead(lead));
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<{ before: ContactDetails | null; after: ContactDetails } | null>(null);
  useEffect(() => { setContact(contactFromLead(lead)); setEditing(false); }, [lead]);

  function changed(saved: ContactDetails | null) {
    setContact(saved); onChanged(saved); router.refresh();
  }
  async function act(action: "suppress_auto_sms" | "mark_personal") {
    if (busy || readOnly) return;
    setBusy(true); setError(""); setNotice(""); setUndo(null);
    try {
      const { contact: saved } = await contactRequest<{ contact: ContactDetails }>(`/api/leads/${lead.id}/contact`, "POST", {
        action, contactId: contact?.id ?? null, version: contact?.version ?? null,
      });
      setUndo({ before: contact, after: saved }); changed(saved);
      setNotice(action === "mark_personal" ? "Marked Personal. Retained calls are now in Personal and excluded from business Reports. Automatic texts are off." : "Automatic texts are off for future missed calls. Existing calls and text outcomes are unchanged.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm the change. Reload before retrying.");
    } finally { setBusy(false); }
  }
  async function undoChange() {
    if (!undo || busy || readOnly) return;
    setBusy(true); setError("");
    try {
      if (undo.before) {
        const before = undo.before;
        const result = await contactRequest<{ contact: ContactDetails }>(`/api/contacts/${undo.after.id}`, "PATCH",
          contactEditPatch(undo.after.version, before.display_name ?? "", before.classification, before.auto_sms_policy));
        changed(result.contact);
      } else {
        await contactRequest(`/api/contacts/${undo.after.id}`, "DELETE", { version: undo.after.version });
        changed(null);
      }
      setUndo(null); setNotice("Contact preference restored. Past skipped texts will not be sent.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not confirm Undo. Reload current preferences."); }
    finally { setBusy(false); }
  }

  if (lead.id.startsWith("sample-")) return null;
  return <section className="lead-contact-controls" aria-label="Contact preferences">
    <p className="t-eyebrow">Contact preferences</p>
    <p className="settings-section__meta">{contact ? `${contact.classification === "personal" ? "Personal" : contact.classification === "customer" ? "Customer" : "Unclassified"} · Automatic texts ${contact.auto_sms_policy === "standard" ? "eligible" : "off"}.` : "Not a saved contact. Ordinary automatic-text rules apply."}</p>
    {!readOnly ? <div className="contact-actions">
      <button className="btn btn-secondary btn-sm" disabled={busy || editing || contact?.auto_sms_policy === "suppress"} onClick={() => void act("suppress_auto_sms")}>Turn off automatic texts</button>
      <button className="btn btn-secondary btn-sm" disabled={busy || editing || contact?.classification === "personal"} onClick={() => void act("mark_personal")}>Mark as personal</button>
      {contact ? <button className="btn btn-ghost btn-sm" disabled={busy || editing} onClick={() => { setEditing(true); setUndo(null); setNotice(""); }}>Edit contact preferences</button> : null}
    </div> : null}
    <p className="settings-section__meta">Personal keeps all history in the <Link href="/leads?filter=personal">Personal view</Link>. Owner call alerts follow your account preferences.</p>
    {busy ? <p role="status">Saving contact preference…</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {undo && !readOnly ? <div className="contact-undo"><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void undoChange()}>Undo contact change</button><p className="settings-section__meta">Undo restores the previous classification and future texting preference. It never sends past skipped texts.</p></div> : null}
    {error ? <div role="alert"><p>{error}</p><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setUndo(null); setError(""); router.refresh(); }}>Reload current preferences</button></div> : null}
    {editing && contact && !readOnly ? <ContactEditor key={`${contact.id}:${contact.version}`} contact={contact} onCancel={() => setEditing(false)} onSaved={(saved) => { changed(saved); setEditing(false); setNotice(saved ? "Contact preferences saved. History now follows this classification." : "Contact removed. Ordinary rules apply to future calls; past skipped texts will not be sent."); }} onStale={() => { setEditing(false); router.refresh(); }} /> : null}
  </section>;
}
