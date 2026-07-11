"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";

// The single highest-stakes control in the product: it turns all customer
// texting (and owner alerts) on or off, gated on carrier registration. It gets
// its own callout — separated from the routine fields — a real switch, and the
// current state spelled out in words that update as you flip it. The native
// checkbox is still the form control (name="sms_enabled"), so the settings form
// submits exactly as before.
export function SmsToggle({ defaultEnabled }: { defaultEnabled: boolean }) {
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
            The master switch for every text — to customers and to you. It can only be turned on
            once carrier (A2P) registration is approved.
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
            onChange={(event) => setEnabled(event.target.checked)}
            aria-label="Automatic texting"
          />
          <span className="switch__track" aria-hidden="true">
            <span className="switch__thumb" />
          </span>
        </span>
      </label>
    </section>
  );
}
