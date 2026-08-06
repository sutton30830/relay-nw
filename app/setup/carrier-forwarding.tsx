"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { CopyButton } from "@/app/copy-button";
import { CARRIERS, getCarrierForwarding } from "@/lib/carriers";

// Carrier-first forwarding setup: pick a carrier and get the applicable codes.
// Relay confirms call capture automatically once a real missed call arrives.
export function CarrierForwarding({ relayNumber }: { relayNumber: string }) {
  const [carrierId, setCarrierId] = useState<string | null>(null);
  const forwarding = getCarrierForwarding(carrierId ?? "other", relayNumber);

  return (
    <div className="carrier-forwarding">
      <p className="setup-copy">
        Pick your carrier for the exact steps. This does not replace your number or send every call to Relay—your phone rings first, and only unanswered calls are forwarded.
      </p>

      <div className="carrier-select" role="group" aria-label="Your phone carrier">
        {CARRIERS.map((carrier) => (
          <button
            key={carrier.id}
            type="button"
            className={`carrier-pill ${carrierId === carrier.id ? "carrier-pill--on" : ""}`}
            aria-pressed={carrierId === carrier.id}
            onClick={() => setCarrierId(carrier.id)}
          >
            {carrier.name}
          </button>
        ))}
      </div>

      {carrierId === null ? (
        <p className="setup-copy setup-copy--tight">
          Not sure? Pick “Other” — the standard codes work on most carriers.
        </p>
      ) : (
        <>
          <p className="setup-copy setup-copy--tight">
            {forwarding.intro}
            {forwarding.confidence === "generic" ? (
              <span className="carrier-tag carrier-tag--generic"> Standard codes</span>
            ) : (
              <span className="carrier-tag carrier-tag--known"> {forwarding.carrierName} steps</span>
            )}
          </p>

          <div className="setup-codes">
            {forwarding.codes.length > 0 ? (
              forwarding.codes.map((item) => (
                <div className="setup-code" key={item.label}>
                  <div>
                    <span>{item.label}</span>
                    <strong>{item.code}</strong>
                  </div>
                  <CopyButton value={item.code} label="Copy" />
                </div>
              ))
            ) : (
              <div className="setup-code">
                <div>
                  <span>No answer</span>
                  <strong>Add your Relay number first</strong>
                </div>
              </div>
            )}
          </div>

          {forwarding.cancelCode ? (
            <p className="setup-copy setup-copy--tight">
              To turn forwarding off later, dial <strong>{forwarding.cancelCode}</strong>.
            </p>
          ) : null}

          <p className="carrier-note">
            <Icon name="info" size={13} /> {forwarding.note}
          </p>
        </>
      )}
    </div>
  );
}
