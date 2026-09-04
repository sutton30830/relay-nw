"use client";

import { useState } from "react";
import type { OwnerNotificationPreferences } from "@/lib/notification-preferences";
import { PushNotificationControl } from "./push-notification-control";

type EventKey = "missedCall" | "voicemailReady" | "inboundReply";
type Channel = "email" | "sms";

const EVENTS: Array<{
  key: EventKey;
  title: string;
  detail: string;
  field: string;
}> = [
  {
    key: "missedCall",
    title: "New missed call",
    detail: "Know immediately when Relay creates a new lead.",
    field: "missed_call",
  },
  {
    key: "voicemailReady",
    title: "Voicemail ready",
    detail: "Receive the verified transcript summary when processing finishes.",
    field: "voicemail_ready",
  },
  {
    key: "inboundReply",
    title: "Customer reply",
    detail: "Get alerted when a caller replies to Relay's automatic text.",
    field: "inbound_reply",
  },
];

function ChannelSwitch({
  label,
  name,
  checked,
  onChange,
}: {
  label: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="notification-channel">
      <span>{label}</span>
      <span className="switch">
        <input
          type="checkbox"
          name={name}
          className="switch__input"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-label={`${label} notification`}
        />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
      </span>
    </label>
  );
}

export function NotificationPreferences({
  initialPreferences,
  pushPublicKey,
  textAlertsActive,
}: {
  initialPreferences: OwnerNotificationPreferences;
  pushPublicKey: string | null;
  textAlertsActive: boolean;
}) {
  const [preferences, setPreferences] = useState(initialPreferences);

  function setChannel(event: EventKey, channel: Channel, checked: boolean) {
    setPreferences((current) => ({
      ...current,
      [event]: {
        ...current[event],
        [channel]: checked,
      },
    }));
  }

  return (
    <section className="notification-preferences" aria-labelledby="notification-preferences-title">
      <input type="hidden" name="notification_preferences_present" value="1" />
      <PushNotificationControl publicKey={pushPublicKey} />
      <div className="notification-preferences__intro">
        <div>
          <p id="notification-preferences-title" className="notification-preferences__title">
            Lead notifications
          </p>
          <p className="notification-preferences__note">
            Choose where Relay alerts you. Your leads remain in the inbox even when an alert is off.
          </p>
        </div>
        <span className={`notification-preferences__text-status ${textAlertsActive ? "is-active" : ""}`}>
          Text alerts {textAlertsActive ? "available" : "not available yet"}
        </span>
      </div>

      <div className="notification-preferences__events">
        {EVENTS.map((event) => (
          <div className="notification-event" key={event.key}>
            <div className="notification-event__copy">
              <strong>{event.title}</strong>
              <span>{event.detail}</span>
            </div>
            <div className="notification-event__channels">
              <ChannelSwitch
                label="Email"
                name={`notification_${event.field}_email`}
                checked={preferences[event.key].email}
                onChange={(checked) => setChannel(event.key, "email", checked)}
              />
              <ChannelSwitch
                label="Text"
                name={`notification_${event.field}_sms`}
                checked={preferences[event.key].sms}
                onChange={(checked) => setChannel(event.key, "sms", checked)}
              />
            </div>
          </div>
        ))}
      </div>

      <label className="notification-urgent">
        <span>
          <strong>Always text urgent voicemails</strong>
          <small>Overrides the voicemail Text switch for emergencies and other fast-priority messages.</small>
        </span>
        <span className="switch">
          <input
            type="checkbox"
            name="notification_urgent_voicemail_sms"
            className="switch__input"
            checked={preferences.urgentVoicemailSms}
            onChange={(event) => setPreferences((current) => ({
              ...current,
              urgentVoicemailSms: event.target.checked,
            }))}
            aria-label="Always text urgent voicemails"
          />
          <span className="switch__track" aria-hidden="true">
            <span className="switch__thumb" />
          </span>
        </span>
      </label>

      <p className="notification-preferences__mandatory">
        Billing, account security, and required compliance notices always go to the notification email.
        {!textAlertsActive ? " Text choices are saved now and take effect as soon as Relay can text you." : ""}
      </p>
    </section>
  );
}
