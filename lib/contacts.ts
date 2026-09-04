import { parsePhoneNumberWithError, isSupportedCountry, type CountryCode } from "libphonenumber-js/max";
import type { ContactClassification, ContactSmsPolicy } from "./supabase/types";

export class ContactError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ContactError"; }
}
export function contactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ContactError(400, "Invalid contact fields");
  }
  return value as Record<string, unknown>;
}
export function contactId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ContactError(400, "Invalid identifier");
  }
  return value;
}
export function contactVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ContactError(400, "A current contact version is required");
  }
  return value;
}
export function contactName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ContactError(400, "Invalid contact name (maximum 120 characters)");
  }
  return value.trim() || null;
}
export function contactClassification(value: unknown = "unclassified"): ContactClassification {
  if (value !== "unclassified" && value !== "customer" && value !== "personal") {
    throw new ContactError(400, "Invalid contact classification");
  }
  return value;
}
export function contactSmsPolicy(value: unknown): ContactSmsPolicy {
  if (value !== "suppress" && value !== "standard") throw new ContactError(400, "Invalid automatic text policy");
  return value;
}

// Conservative historical key. Keep fixtures in parity with the SQL helper;
// saved contacts additionally pass the numbering-plan validation below.
export function knownContactPhoneKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!input || !/^[+0-9 ().\-\t\r\n]+$/.test(input) || !/^\+?[^+]+$/.test(input)) return null;
  const digits = input.replace(/[^0-9]/g, "");
  if (input.startsWith("+")) return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : null;
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(national) ? `+1${national}` : null;
}
export function parseContactPhone(value: unknown, country: string = "US"): string {
  if (typeof value !== "string" || value.length > 100 ||
    !/^[+0-9 ().\-\t\r\n]+$/.test(value.trim()) || !/^\+?[^+]+$/.test(value.trim()) ||
    !isSupportedCountry(country)) throw new ContactError(400, "Invalid phone number or country");
  try {
    const phone = parsePhoneNumberWithError(value.trim(), { defaultCountry: country as CountryCode, extract: false });
    if (phone.ext || !phone.isValid()) throw new Error("invalid");
    return phone.number;
  } catch { throw new ContactError(400, "Enter a valid phone number without an extension"); }
}
