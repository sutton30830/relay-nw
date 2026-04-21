"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

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
    <form
      action="/api/intake"
      method="POST"
      className="space-y-5"
      onSubmit={handleSubmit}
      noValidate
    >
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

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="mb-2 block font-semibold">Your name</span>
          <input
            ref={nameRef}
            className="field"
            name="name"
            autoComplete="name"
            placeholder="Jane Smith"
          />
        </label>

        <label className="block">
          <span className="mb-2 block font-semibold">Best phone number</span>
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
          <span className="mt-1 block text-xs text-[var(--muted)]">
            US numbers only. We&apos;ll text you at this number.
          </span>
        </label>
      </div>

      <label className="block">
        <span className="mb-2 block font-semibold">What can we help with?</span>
        <textarea
          className="field min-h-44"
          name="message"
          placeholder="Example: leaking outdoor faucet, no hot water, broken outlet..."
          maxLength={2000}
        />
      </label>

      <label className="flex gap-3 rounded-md border border-[var(--line)] bg-white p-4 text-sm leading-6 text-[var(--muted)]">
        <input
          ref={consentRef}
          className="mt-1 h-4 w-4 shrink-0"
          name="consent"
          type="checkbox"
          required
        />
        <span>
          I agree to be contacted by phone or text about this request. Message and data rates may
          apply. Reply STOP to opt out.
        </span>
      </label>

      {clientError ? (
        <div className="alert alert--error" role="alert">
          {clientError}
        </div>
      ) : null}

      <button
        type="submit"
        className="button-primary w-full"
        disabled={submitting}
        aria-disabled={submitting}
      >
        {submitting ? "Sending..." : "Send request"}
      </button>

      <p className="text-center text-xs text-[var(--muted)]">
        Your information is only used to follow up about this request.
      </p>
    </form>
  );
}
