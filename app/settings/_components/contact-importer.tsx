"use client";
import { useEffect, useRef, useState } from "react";
import { getCountries } from "libphonenumber-js/max";
import { contactRequest, type ContactDetails } from "@/lib/contact-client";
import { csvEntries, IMPORT_BYTES, previewEntries, readCsv, suggestMapping, vcardEntries, type CsvMapping, type ImportEntry, type ImportRow } from "@/lib/contact-import";

type BatchResult = { added: number; existing: number; duplicates: number; rejected: { index: number; error: string }[] };
export function ContactImporter({ onChanged, onOpenChange }: { onChanged: () => void; onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [country, setCountry] = useState("US");
  const [source, setSource] = useState<"csv" | "vcard">("csv");
  const [csv, setCsv] = useState<string[][]>([]);
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [mapping, setMapping] = useState<CsvMapping>({ names: [], phones: [] });
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [existing, setExisting] = useState<Record<string, ContactDetails>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [personal, setPersonal] = useState<Set<number>>(new Set());
  const [step, setStep] = useState<"choose" | "preview" | "review" | "result">("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [totals, setTotals] = useState({ added: 0, existing: 0, rejected: 0 });
  const [uncertain, setUncertain] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, step]);
  function reset() { setCsv([]); setEntries([]); setRows([]); setSelected(new Set()); setPersonal(new Set()); setCompleted(0); setTotals({ added: 0, existing: 0, rejected: 0 }); setUncertain(false); setStep("choose"); setError(""); setPage(0); }
  async function choose(file?: File) {
    reset(); if (!file) return;
    setBusy(true);
    try {
      if (file.size > IMPORT_BYTES) throw new Error("Maximum file size is 2 MB.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (/\.csv$/i.test(file.name)) { const data = readCsv(text); setCsv(data); setMapping(suggestMapping(data[0] ?? [])); setSource("csv"); }
      else if (/\.(vcf|vcard)$/i.test(file.name)) { setEntries(vcardEntries(text)); setSource("vcard"); }
      else throw new Error("Choose a .csv, .vcf, or .vcard file.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read file."); }
    finally { setBusy(false); }
  }
  async function preview() {
    setBusy(true); setError("");
    try {
      const parsed = previewEntries(source === "csv" ? csvEntries(csv, mapping) : entries, country);
      const matches: Record<string, ContactDetails> = {};
      const defaults = new Map<string, ImportRow>();
      for (const row of parsed) {
        if (row.error || !row.normalized) continue;
        const prior = defaults.get(row.normalized);
        if (!prior || (!prior.displayName && row.displayName)) defaults.set(row.normalized, row);
      }
      const valid = [...defaults.values()];
      for (let i = 0; i < valid.length; i += 250) {
        const result = await contactRequest<{ existing: Record<string, ContactDetails>; rejected: unknown[] }>("/api/contacts/import", "POST", { mode: "preview", source, country, entries: valid.slice(i, i + 250).map((r) => ({ phone: r.phone, displayName: r.displayName })) });
        if (result.rejected.length) throw new Error("Server validation changed. Review your country and file before trying again.");
        Object.assign(matches, result.existing);
      }
      setRows(parsed); setExisting(matches); setSelected(new Set(valid.map((r) => r.index))); setPersonal(new Set()); setStep("preview"); setCsv([]); setEntries([]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Preview failed."); }
    finally { setBusy(false); }
  }
  const chosen = rows.filter((r) => selected.has(r.index));
  async function runImport() {
    if (busy) return; setBusy(true); setError("");
    let count = completed;
    try {
      while (count < chosen.length) {
        const batch = chosen.slice(count, count + 250);
        const result = await contactRequest<BatchResult>("/api/contacts/import", "POST", { mode: "import", source, country, entries: batch.map((r) => ({ phone: r.normalized, displayName: r.displayName, classification: personal.has(r.index) ? "personal" : "unclassified" })) });
        setTotals((t) => ({ added: t.added + result.added, existing: t.existing + result.existing, rejected: t.rejected + result.rejected.length }));
        count += batch.length; setCompleted(count); onChanged();
      }
      setStep("result");
    } catch { setUncertain(true); setError("Import interrupted. Confirmed batches are saved. Retry resumes the unconfirmed batch safely and keeps existing names and preferences."); }
    finally { setBusy(false); }
  }
  function toggle(index: number) {
    setSelected((old) => { const next = new Set(old); if (next.has(index)) next.delete(index); else { const phone = rows[index].normalized; rows.forEach((r) => { if (r.normalized === phone) next.delete(r.index); }); next.add(index); } return next; });
  }
  if (!open) return <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen(true); onOpenChange(true); }}>Import contacts</button>;
  return <div className="contact-editor sentry-block" aria-label="Import contacts">
    <h3 ref={heading} tabIndex={-1}>Import contacts · {step === "choose" ? "Choose file" : step === "preview" ? "Preview" : step === "review" ? "Review" : "Result"}</h3>
    <p className="settings-section__meta">CSV or Apple/iCloud vCard. Up to 2 MB and 2,000 phone entries. New contacts are Unclassified with automatic texts off. Importing creates no leads and sends no messages.</p>
    {error && <p role="alert" className="convo__error">{error}</p>}
    <fieldset disabled={busy}>
      {step === "choose" && <>
        <label className="form-field"><span>Contact file</span><input type="file" accept=".csv,.vcf,.vcard" onChange={(e) => void choose(e.target.files?.[0])} /></label>
        <label className="form-field"><span>Country for numbers without + country code</span><select className="field" value={country} onChange={(e) => setCountry(e.target.value)}>{getCountries().map((code) => <option key={code} value={code}>{new Intl.DisplayNames(["en"], { type: "region" }).of(code)} ({code})</option>)}</select></label>
        <p className="settings-section__meta">Use international + numbers for mixed-country files. Extensions and unsupported values must be corrected in the source. UTF-8 CSV and vCard 3.0/4.0 are supported.</p>
        {csv.length > 0 && <div><p>Review column mapping. Select every phone column to include. Select name parts in file order; leave names unchecked to import numbers only.</p>{csv[0].map((header, i) => <div key={i} className="contact-import-column"><strong>{header || `Column ${i + 1}`}</strong>{(["names", "phones"] as const).map((key) => <label key={key}><input type="checkbox" aria-label={`${key === "names" ? "Name" : "Phone"}: ${header || `Column ${i + 1}`}`} checked={mapping[key].includes(i)} onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.checked ? [...m[key], i].sort((a, b) => a - b) : m[key].filter((v) => v !== i) }))} /> {key === "names" ? "Name" : "Phone"}</label>)}</div>)}</div>}
        <button type="button" className="btn btn-primary btn-sm" disabled={source === "csv" ? !csv.length || !mapping.phones.length : !entries.length} onClick={() => void preview()}>Preview contacts</button>
      </>}
      {step === "preview" && <>
        <p>{rows.length} phone entries · {rows.filter((r) => r.error).length} invalid · {rows.filter((r) => r.duplicateOf !== null).length} duplicates · {chosen.length} selected</p>
        <p className="settings-section__meta">Duplicate numbers import once. To resolve a name conflict, select the preferred row. Existing contacts always keep their saved name, classification, and texting preference. Select Personal only for individual new contacts you want outside business Reports.</p>
        <ul className="contact-list">{rows.slice(page * 20, page * 20 + 20).map((row) => {
          const saved = row.normalized ? existing[row.normalized] : undefined;
          return <li key={row.index}><label><input type="checkbox" disabled={!!row.error} checked={selected.has(row.index)} onChange={() => toggle(row.index)} /> <strong>{row.displayName || "No name"}</strong></label><span className="contact-phone">{row.phone || "No phone number"}{row.normalized && ` → ${row.normalized}`}</span>
            <p className="contact-meta">{row.error || (saved ? `Existing — keep ${saved.display_name || "no name"}, ${saved.classification}, automatic texts ${saved.auto_sms_policy === "standard" ? "eligible" : "off"}` : "New — automatic texts off")}{row.duplicateOf !== null ? row.conflict ? " · Duplicate with conflicting name; choose one row" : " · Duplicate number; choose one row" : ""}</p>
            {!row.error && !saved && <label><input type="checkbox" disabled={!selected.has(row.index)} checked={personal.has(row.index)} onChange={(e) => setPersonal((old) => { const next = new Set(old); if (e.target.checked) next.add(row.index); else next.delete(row.index); return next; })} /> Mark this contact Personal</label>}</li>;
        })}</ul>
        <div className="contact-actions"><button type="button" className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(rows.length / 20)}</span><button type="button" className="btn btn-secondary btn-sm" disabled={(page + 1) * 20 >= rows.length} onClick={() => setPage(page + 1)}>Next</button><button type="button" className="btn btn-primary btn-sm" disabled={!chosen.length} onClick={() => setStep("review")}>Review selection</button></div>
      </>}
      {step === "review" && <>
        <p>{chosen.length} unique numbers selected. {chosen.filter((r) => existing[r.normalized!]).length} already saved. {chosen.filter((r) => personal.has(r.index) && !existing[r.normalized!]).length} new Personal selections. {rows.filter((r) => r.error).length} invalid rows excluded.</p>
        <p>Existing contacts are kept unchanged, including changes made since preview. New entries have automatic texts off. Personal calls move out of business views; retained history is preserved.</p>
        <p role="status">{completed} of {chosen.length} entries confirmed.</p>
        <div className="contact-actions">{!completed && !uncertain && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep("preview")}>Back to preview</button>}<button type="button" className="btn btn-primary btn-sm" onClick={() => void runImport()}>{uncertain ? "Retry remaining import" : "Import selected contacts"}</button></div>
      </>}
      {step === "result" && <div role="status"><p>Import complete: {totals.added} added · {totals.existing} existing · {totals.rejected} rejected by server. {rows.filter((r) => r.error).length} invalid file entries excluded before import.</p>{uncertain && <p>A previous response was interrupted. Counts describe confirmed responses; contacts saved by an unconfirmed attempt are counted as existing on retry.</p>}<button type="button" className="btn btn-secondary btn-sm" onClick={reset}>Choose another file</button></div>}
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { reset(); setOpen(false); onOpenChange(false); }}>Close import</button>
    </fieldset>
    {busy && <p role="status">{step === "review" ? "Importing contacts…" : "Preparing preview…"}</p>}
  </div>;
}
