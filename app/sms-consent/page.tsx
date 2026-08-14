"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Icon } from "@/components/icon";

export default function SmsConsentPage() {
  const [phone, setPhone] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!phone.trim()) {
      setError("Please enter your phone number.");
      return;
    }

    setError(null);
    setSubmitted(true);
  }

  return (
    <main className="intake-view">
      <header className="intake-top">
        <Link className="app-head__brand app-head__brand--link" href="/">
          <div className="brand-mark">
            <Icon name="relay" size={18} />
          </div>
          <h1 className="t-display app-head__name">Relay NW</h1>
        </Link>
      </header>

      <section className="intake-shell">
        <div className="intake-shell__intro">
          <p className="t-eyebrow">SMS consent</p>
          <h2 className="t-display intake-side__title">Receive a follow-up text from Relay NW.</h2>
          <p className="intake-side__lede">
            Submit your phone number to consent to a one-time text message about your inquiry.
            Relay NW is a service operated by Lowry Works LLC.
          </p>
        </div>

        <section className="intake-form panel">
          <div className="intake-form__head">
            <p className="t-eyebrow">Contact form</p>
            <h2 className="t-display intake-form__title">Tell us where to text.</h2>
          </div>

          <div className="intake-form__body">
            {submitted ? (
              <div className="intake-success" role="status">
                Thanks for signing up! You will receive a text from Relay NW if we miss your call.
                Message & data rates may apply.
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
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
                    onChange={(event) => setPhone(event.target.value)}
                    required
                  />
                </label>

                <label className="consent-row">
                  <input type="checkbox" name="smsConsent" />
                  <span>
                    I agree to receive SMS messages from Relay NW regarding missed-call follow-up
                    and responses to my inquiry. Message frequency varies. Message and data rates
                    may apply. Reply STOP to opt out or HELP for help. Consent is not required to
                    use our services. View our <Link href="/terms">Terms</Link> and{" "}
                    <Link href="/privacy">Privacy Policy</Link>.
                  </span>
                </label>

                {error ? (
                  <div className="intake-error" role="alert">
                    <Icon name="alertTriangle" size={14} /> {error}
                  </div>
                ) : null}

                <button type="submit" className="btn btn-primary intake-submit">
                  Submit consent <Icon name="arrowRight" size={14} />
                </button>
              </form>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
