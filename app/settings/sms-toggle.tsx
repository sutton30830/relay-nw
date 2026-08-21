"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";

// The single highest-stakes control in the product: it turns all customer
// texting on or off, gated on carrier registration. It gets
// its own callout — separated from the routine fields — a real switch, and the
// current state spelled out in words that update as you flip it. The native
// checkbox is still the form control (name="sms_enabled"), so the settings form
// submits exactly as before.
export function SmsToggle({
  defaultEnabled,
  available,
}: {
  defaultEnabled: boolean;
  available: boolean;
}) {
  const [enabled, setEnabled] = useState(defaultEnabled);

  return (
    <section className={`sms-switch ${enabled ? "sms-switch--on" : "sms-switch--off"}`}>
      <div className="sms-switch__info">
        <span className="sms-switch__icon">
          <Icon name="shield" size={16} />
        </span>
        <div>
          <p className="sms-switch__title">Automatic texting</p>
          <p className="sms-switch__note">
            {available
              ? "Send an immediate follow-up when Relay catches a missed call."
              : "Relay is enabling this for you. Calls and your inbox already work while texting is prepared."}
          </p>
        </div>
      </div>

      <label className="sms-switch__control">
        <span className="sms-switch__state" aria-live="polite">
          Texting is <strong>{enabled ? "ON" : "OFF"}</strong>
        </span>
        <span className="switch">
          <input
            type="checkbox"
            name="sms_enabled"
            className="switch__input"
            checked={enabled}
            disabled={!available}
            onChange={(event) => setEnabled(event.target.checked)}
            aria-label="Automatic texting"
          />
          <span className="switch__track" aria-hidden="true">
            <span className="switch__thumb" />
          </span>
        </span>
      </label>
      {available && enabled && !defaultEnabled ? (
        <label className="sms-switch__consent">
          <input
            type="checkbox"
            name="sms_activation_consent"
            value="on"
            required
          />
          <span>
            I authorize Relay to automatically text callers after missed calls using the
            message saved on this page. I can turn texting off at any time.
          </span>
        </label>
      ) : null}
      {!available ? (
        <input type="hidden" name="sms_enabled" value={defaultEnabled ? "on" : "off"} />
      ) : null}
    </section>
  );
}
