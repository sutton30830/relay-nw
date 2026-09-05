"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lead } from "@/lib/supabase/types";
import { contactFromLead, type ContactDetails } from "@/lib/contact-client";
import { ContactEditor } from "@/app/settings/_components/contact-editor";

export function LeadContactControls({ lead, readOnly, onChanged }: {
  lead: Lead; readOnly: boolean; onChanged: (contact: ContactDetails | null) => void;
}) {
  const router = useRouter();
  const [contact, setContact] = useState(() => contactFromLead(lead));
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setContact(contactFromLead(lead)); setEditing(false); }, [lead]);
  function close() { setEditing(false); requestAnimationFrame(() => editButton.current?.focus()); }

  if (lead.id.startsWith("sample-")) return null;
  return <section className="lead-contact-controls" aria-label="Contact preferences">
    <div className="contact-heading"><p className="t-eyebrow">Contact preferences</p>
      {!readOnly && !editing ? <button ref={editButton} type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(true); setNotice(""); }}>{contact ? "Edit contact" : "Save contact"}</button> : null}
    </div>
    {!editing ? <>
      <p className="settings-section__meta">{contact ? `${contact.classification === "personal" ? "Personal" : contact.classification === "customer" ? "Customer" : "Unclassified"} · Automatic texts ${contact.auto_sms_policy === "standard" ? "on" : "off"}` : "Not saved · Standard automatic-text rules apply"}</p>
      <p className="settings-section__meta">{contact?.classification === "personal" ? "Calls appear in Personal, outside business Reports. History is kept." : "Calls appear in your business inbox and Reports."}</p>
    </> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {editing && !readOnly ? <ContactEditor key={contact ? `${contact.id}:${contact.version}` : lead.id} contact={contact} phone={lead.phone} onCancel={close} onSaved={(saved) => {
      setContact(saved); onChanged(saved); router.refresh(); close();
      setNotice(saved ? "Contact saved. Your preferences apply to future missed calls." : "Contact removed. Future calls follow standard texting rules. History is kept.");
    }} onStale={() => { close(); router.refresh(); }} /> : null}
  </section>;
}
