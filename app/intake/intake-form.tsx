"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/icon";

function formatUsPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);

  // Handle leading 1 for country code.
  let rest = digits;
  let prefix = "";
  if (digits.length === 11 && digits.startsWith("1")) {
    prefix = "1 ";
    rest = digits.slice(1);
  }

  if (rest.length === 0) {
    return prefix.trim();
  }

  if (rest.length <= 3) {
    return `${prefix}(${rest}`;
  }

  if (rest.length <= 6) {
    return `${prefix}(${rest.slice(0, 3)}) ${rest.slice(3)}`;
  }

  return `${prefix}(${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6, 10)}`;
}

function countDigits(value: string) {
  return value.replace(/\D/g, "").length;
}

export function IntakeForm() {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const consentRef = useRef<HTMLInputElement | null>(null);
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handlePhoneChange(event: React.ChangeEvent<HTMLInputElement>) {
    setPhone(formatUsPhone(event.target.value));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const digits = countDigits(phone);
    if (digits < 10) {
      event.preventDefault();
      setClientError("Please enter a 10-digit phone number so we can reach you.");
      return;
    }

    if (!consentRef.current?.checked) {
      event.preventDefault();
      setClientError("Please check the consent box so we can follow up about your request.");
      consentRef.current?.focus();
      return;
    }

    setClientError(null);
    setSubmitting(true);
  }

  return (
    <form action="/api/intake" method="POST" onSubmit={handleSubmit} noValidate>
      {/* Honeypot — real users won't see or fill this. */}
      <div className="honeypot" aria-hidden="true">
        <label>
          Company
          <input
            type="text"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </label>
      </div>

      <div className="intake-row">
        <label className="field-label">
          <span>Name</span>
          <input
            ref={nameRef}
            className="field"
            name="name"
            autoComplete="name"
            placeholder="Jane Smith"
          />
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
            onChange={handlePhoneChange}
            required
          />
          <span className="field-hint">
            US only. We&apos;ll text or call this number.
          </span>
        </label>
      </div>

      <label className="field-label">
        <span>How can we help?</span>
        <textarea
          className="field"
          name="message"
          rows={5}
          placeholder="Example: leaking faucet, water heater noise, kitchen sink backed up..."
          maxLength={2000}
        />
        <span className="field-hint">
          One or two sentences is perfect.
        </span>
      </label>

      <label className="consent-row">
        <input
          ref={consentRef}
          name="consent"
          type="checkbox"
          required
        />
        <span>
          I agree to be contacted by phone or text about this request. Message and data rates may
          apply. Reply <span className="t-mono">STOP</span> to opt out anytime.
        </span>
      </label>

      {clientError ? (
        <div className="intake-error" role="alert">
          <Icon name="alertTriangle" size={14} /> {clientError}
        </div>
      ) : null}

      <button
        type="submit"
        className="btn btn-primary intake-submit"
        disabled={submitting}
        aria-disabled={submitting}
      >
        {submitting ? "Sending..." : "Send request"} <Icon name="arrowRight" size={14} />
      </button>

      <p className="intake-foot">
        <Icon name="shield" size={11} />
        Your information is only used to follow up about this request.
      </p>
    </form>
  );
}
