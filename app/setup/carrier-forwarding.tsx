"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { CopyButton } from "@/app/copy-button";
import { CARRIERS, getCarrierForwarding } from "@/lib/carriers";

// Carrier-first forwarding setup: pick your carrier, get the exact codes. The
// Full test below confirms it actually worked, so the codes are a starting
// point, not a promise.
export function CarrierForwarding({ relayNumber }: { relayNumber: string }) {
  const [carrierId, setCarrierId] = useState<string | null>(null);
  const forwarding = getCarrierForwarding(carrierId ?? "other", relayNumber);

  return (
    <div className="carrier-forwarding">
      <p className="setup-copy">
        Forward the calls you miss on your existing business number to Relay. Pick your carrier for the exact steps.
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
          Not sure? Pick “Other” — the standard codes work on most carriers, and the test below will confirm it.
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
