import Link from "next/link";
import { Icon } from "@/components/icon";
import type { OwnerCapability, OwnerServiceStatus } from "@/lib/owner-service-status";

const TONE_ICON: Record<OwnerCapability["tone"], "check" | "clock" | "alertTriangle" | "x"> = {
  ready: "check",
  pending: "clock",
  attention: "alertTriangle",
  off: "x",
};

// One line per capability, one next step. The strip is deliberately quiet
// when everything is on so it never competes with the leads below it.
export function ServiceStatusStrip({ status }: { status: OwnerServiceStatus }) {
  const capabilities = [status.calls, status.transcription, status.texting];
  const blocked = capabilities.filter((capability) => capability.nextStep);

  return (
    <section className="service-status" aria-label="Relay service status">
      <div className="service-status__row">
        <p className="service-status__headline">{status.headline}</p>
        <Link className="service-status__link" href="/setup">
          Details <Icon name="arrowRight" size={13} />
        </Link>
      </div>
      <ul className="service-status__list">
        {capabilities.map((capability) => (
          <li
            key={capability.key}
            className={`service-status__item service-status__item--${capability.tone}`}
            title={capability.detail}
          >
            <Icon name={TONE_ICON[capability.tone]} size={12} />
            <span className="service-status__title">{capability.title}</span>
            <span className="service-status__label">{capability.label}</span>
          </li>
        ))}
      </ul>
      {blocked.map((capability) => (
        <p className="service-status__next" key={capability.key}>
          {capability.owner === "you" ? <strong>Your next step: </strong> : <strong>{capability.title}: </strong>}
          {capability.nextStep}
        </p>
      ))}
    </section>
  );
}
