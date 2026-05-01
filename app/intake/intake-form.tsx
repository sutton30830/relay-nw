"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/icon";

function formatUsPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  let rest = digits;
  let prefix = "";

  if (digits.length === 11 && digits.startsWith("1")) {
    prefix = "1 ";
    rest = digits.slice(1);
  }

  if (rest.length === 0) return prefix.trim();
  if (rest.length <= 3) return `${prefix}(${rest}`;
  if (rest.length <= 6) return `${prefix}(${rest.slice(0, 3)}) ${rest.slice(3)}`;

  return `${prefix}(${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6, 10)}`;
}

function hasValue(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement
    ? Boolean(field.value.trim())
    : false;
}

export function IntakeForm() {
  const businessNameRef = useRef<HTMLInputElement | null>(null);
  const [phone, setPhone] = useState("");
  const [businessNumber, setBusinessNumber] = useState("");
  const [callbackNumber, setCallbackNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => {
    businessNameRef.current?.focus();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const requiredFields = ["businessName", "ownerName", "phone", "businessType", "currentBusinessNumber"];
    const missingField = requiredFields.find((field) => !hasValue(form, field));

    if (missingField) {
      event.preventDefault();
      setClientError("Please fill out the required fields so we can start setup.");
      return;
    }

    setClientError(null);
    setSubmitting(true);
  }

  return (
    <form action="/api/intake" method="POST" onSubmit={handleSubmit}>
      <div className="honeypot" aria-hidden="true">
        <label>
          Company
          <input type="text" name="company" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>

      <label className="field-label">
        <span>Business name</span>
        <input
          ref={businessNameRef}
          className="field"
          name="businessName"
          autoComplete="organization"
          placeholder="ABC Plumbing"
          required
        />
      </label>

      <div className="intake-row">
        <label className="field-label">
          <span>Owner name</span>
          <input className="field" name="ownerName" autoComplete="name" placeholder="Jane Smith" required />
        </label>

        <label className="field-label">
          <span>Phone number</span>
          <input
            className="field"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(206) 555-0123"
            value={phone}
            onChange={(event) => setPhone(formatUsPhone(event.target.value))}
            required
          />
        </label>
      </div>

      <div className="intake-row">
        <label className="field-label">
          <span>Business type</span>
          <select className="field" name="businessType" defaultValue="" required>
            <option value="" disabled>Select one</option>
            <option value="HVAC">HVAC</option>
            <option value="Plumbing">Plumbing</option>
            <option value="Electrical">Electrical</option>
            <option value="Other">Other</option>
          </select>
        </label>

        <label className="field-label">
          <span>Current business number</span>
          <input
            className="field"
            name="currentBusinessNumber"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(206) 555-0199"
            value={businessNumber}
            onChange={(event) => setBusinessNumber(formatUsPhone(event.target.value))}
            required
          />
        </label>
      </div>

      <label className="field-label">
        <span>Preferred callback number <span className="field-optional">optional</span></span>
        <input
          className="field"
          name="preferredCallbackNumber"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="Leave blank if same as above"
          value={callbackNumber}
          onChange={(event) => setCallbackNumber(formatUsPhone(event.target.value))}
        />
      </label>

      <label className="field-label">
        <span>Notes <span className="field-optional">optional</span></span>
        <textarea
          className="field"
          name="notes"
          rows={4}
          placeholder="Anything helpful about your current phone setup, business hours, or greeting."
          maxLength={2000}
        />
      </label>

      {clientError ? (
        <div className="intake-error" role="alert">
          <Icon name="alertTriangle" size={14} /> {clientError}
        </div>
      ) : null}

      <button type="submit" className="btn btn-primary intake-submit" disabled={submitting} aria-disabled={submitting}>
        {submitting ? "Sending..." : "Submit setup info"} <Icon name="arrowRight" size={14} />
      </button>

      <p className="intake-foot">
        <Icon name="shield" size={11} />
        We&apos;ll only use this to help set up Relay NW.
      </p>
    </form>
  );
}
