import { ContactError, contactName, parseContactPhone } from "./contacts";

export const IMPORT_BYTES = 2 * 1024 * 1024;
export const IMPORT_ROWS = 2000;
export type ImportEntry = { phone: string; displayName: string | null };
export type CsvMapping = { names: number[]; phones: number[] };
export type ImportRow = ImportEntry & { index: number; normalized: string | null; error: string | null; duplicateOf: number | null; conflict: boolean };

// Deliberately bounded RFC 4180 reader. Reject malformed quoting instead of repairing it.
export function readCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ""; let quoted = false; let closed = false;
  const pushRow = () => { row.push(value); if (row.length > 200) throw new ContactError(400, "Maximum 200 CSV columns"); if (row.some((cell) => cell.trim())) rows.push(row); row = []; value = ""; closed = false; if (rows.length > IMPORT_ROWS + 1) throw new ContactError(400, "Maximum 2,000 source rows"); };
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += c; continue; }
    if (c === ',') { row.push(value); value = ""; closed = false; if (row.length > 200) throw new ContactError(400, "Maximum 200 CSV columns"); }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else if (c === '"' && !value && !closed) quoted = true;
    else { if (closed || c === '"') throw new ContactError(400, "Malformed CSV quoting"); value += c; }
  }
  if (quoted) throw new ContactError(400, "Unclosed CSV quote");
  pushRow(); return rows;
}
export function suggestMapping(headers: string[]): CsvMapping {
  const names = headers.flatMap((h, i) => /^(name|full name)$/i.test(h.trim()) ? [i] : []);
  const parts = headers.flatMap((h, i) => /^(first name|middle name|last name|given name|family name)$/i.test(h.trim()) ? [i] : []);
  return { names: names.length ? names : parts, phones: headers.flatMap((h, i) => /^(phone(?: \d+)?(?: - value)?|mobile|telephone)$/i.test(h.trim()) ? [i] : []) };
}
export function csvEntries(rows: string[][], mapping: CsvMapping): ImportEntry[] {
  if (!rows.length || !mapping.phones.length || [...mapping.names, ...mapping.phones].some((i) => !Number.isInteger(i) || i < 0 || i >= rows[0].length)) throw new ContactError(400, "Choose valid CSV phone columns");
  return rows.slice(1).flatMap((row) => {
    if (row.length !== rows[0].length) return [{ phone: "", displayName: "CSV column count differs from header" }];
    const displayName = mapping.names.map((i) => row[i].trim()).filter(Boolean).join(" ") || null;
    const phones = mapping.phones.flatMap((i) => row[i].split(/\s*:::\s*/).filter((p) => p.trim()));
    return (phones.length ? phones : [""]).map((phone) => ({ phone, displayName }));
  });
}
function unescapeCard(value: string) { return value.replace(/\\([nN,;\\])/g, (_, c: string) => /n/i.test(c) ? "\n" : c); }
export function vcardEntries(text: string): ImportEntry[] {
  const entries: ImportEntry[] = []; let card: { name: string | null; phones: string[]; version: string; unsupported: boolean } | null = null;
  for (const line of text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
    if (!line.trim()) continue;
    if (/^BEGIN:VCARD$/i.test(line)) { if (card) throw new ContactError(400, "Nested vCard"); card = { name: null, phones: [], version: "", unsupported: false }; continue; }
    if (!card) throw new ContactError(400, "Expected BEGIN:VCARD");
    if (/^END:VCARD$/i.test(line)) {
      if (!["3.0", "4.0"].includes(card.version)) throw new ContactError(400, "Only UTF-8 vCard 3.0 and 4.0 are supported; re-export older cards");
      entries.push(...(card.phones.length ? card.phones : [""]).map((phone) => ({ phone: card!.unsupported ? "Unsupported vCard encoding or phone parameters" : phone, displayName: card!.name })));
      card = null; if (entries.length > IMPORT_ROWS) throw new ContactError(400, "Maximum 2,000 phone entries"); continue;
    }
    const colon = line.indexOf(":"); if (colon < 0) throw new ContactError(400, "Malformed vCard property");
    const header = line.slice(0, colon); const key = header.split(";")[0].split(".").pop()!.toUpperCase(); const value = line.slice(colon + 1);
    if (key === "VERSION") card.version = value;
    if (["FN", "N", "TEL"].includes(key) && /ENCODING=|CHARSET=(?!UTF-8(?:;|$))/i.test(header)) card.unsupported = true;
    if (key === "FN") card.name = unescapeCard(value);
    if (key === "N" && !card.name) card.name = value.split(/(?<!\\);/).map(unescapeCard).filter(Boolean).join(" ");
    if (key === "TEL") card.phones.push(unescapeCard(value).replace(/^tel:/i, ""));
  }
  if (card) throw new ContactError(400, "Unclosed vCard");
  if (!entries.length) throw new ContactError(400, "No contacts found"); return entries;
}
export function previewEntries(entries: ImportEntry[], country: string): ImportRow[] {
  if (!entries.length || entries.length > IMPORT_ROWS) throw new ContactError(400, "Choose 1 to 2,000 phone entries");
  const seen = new Map<string, ImportRow>();
  return entries.map((entry, index) => {
    const row: ImportRow = { ...entry, index, normalized: null, error: null, duplicateOf: null, conflict: false };
    try { row.displayName = contactName(entry.displayName); row.normalized = parseContactPhone(entry.phone, country); }
    catch (error) { row.error = error instanceof Error ? error.message : "Invalid contact"; }
    if (row.normalized && !row.error) {
      const prior = seen.get(row.normalized);
      if (prior) { row.duplicateOf = prior.index; row.conflict = prior.displayName !== row.displayName; } else seen.set(row.normalized, row);
    }
    return row;
  });
}
