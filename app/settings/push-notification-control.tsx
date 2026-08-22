"use client";

import { useEffect, useState } from "react";

type PushState =
  | "checking"
  | "unavailable"
  | "unsupported"
  | "off"
  | "enabling"
  | "on"
  | "denied"
  | "error";

function applicationServerKey(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function supportsPush() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || ("standalone" in navigator && navigator.standalone === true);
}

async function saveSubscription(input: {
  subscription: PushSubscription;
  missedCallEnabled: boolean;
  voicemailReadyEnabled: boolean;
}) {
  const response = await fetch("/api/push/subscriptions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: input.subscription.toJSON(),
      missedCallEnabled: input.missedCallEnabled,
      voicemailReadyEnabled: input.voicemailReadyEnabled,
    }),
  });

  if (!response.ok) {
    throw new Error("Relay could not save this browser for notifications.");
  }
}

export function PushNotificationControl({
  publicKey,
}: {
  publicKey: string | null;
}) {
  const [state, setState] = useState<PushState>("checking");
  const [message, setMessage] = useState<string | null>(null);
  const [installAvailable, setInstallAvailable] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [missedCallEnabled, setMissedCallEnabled] = useState(true);
  const [voicemailReadyEnabled, setVoicemailReadyEnabled] = useState(true);

  useEffect(() => {
    const updateInstallState = () => {
      setInstalled(isStandalone());
      setInstallAvailable(Boolean(window.__relayInstallPrompt));
    };
    updateInstallState();
    window.addEventListener("relay-install-ready", updateInstallState);
    window.addEventListener("relay-install-complete", updateInstallState);

    if (!publicKey) {
      setState("unavailable");
      return () => {
        window.removeEventListener("relay-install-ready", updateInstallState);
        window.removeEventListener("relay-install-complete", updateInstallState);
      };
    }
    if (!supportsPush()) {
      setState("unsupported");
      return () => {
        window.removeEventListener("relay-install-ready", updateInstallState);
        window.removeEventListener("relay-install-complete", updateInstallState);
      };
    }

    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        setState(subscription ? "on" : Notification.permission === "denied" ? "denied" : "off");
      })
      .catch(() => setState("error"));

    return () => {
      window.removeEventListener("relay-install-ready", updateInstallState);
      window.removeEventListener("relay-install-complete", updateInstallState);
    };
  }, [publicKey]);

  async function installApp() {
    const prompt = window.__relayInstallPrompt;
    if (!prompt) {
      setMessage("On iPhone, use Share → Add to Home Screen. On Android, use the browser menu → Install app.");
      return;
    }

    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") {
      delete window.__relayInstallPrompt;
      setInstallAvailable(false);
      setMessage("Relay is installed. Open it from your Home Screen to finish enabling alerts.");
    }
  }

  async function enablePush() {
    if (!publicKey || !supportsPush()) return;
    setState("enabling");
    setMessage(null);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        setMessage("Notifications are blocked in this browser. Allow them in browser settings, then try again.");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
      await saveSubscription({ subscription, missedCallEnabled, voicemailReadyEnabled });
      setState("on");
      setMessage("Browser alerts are on for this device. They do not depend on texting approval.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Could not enable browser notifications.");
    }
  }

  async function disablePush() {
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/push/subscriptions", {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error("Relay could not turn off alerts. Please try again.");
        await subscription.unsubscribe();
      }
      setState("off");
      setMessage("Browser alerts are off for this device.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Could not disable browser notifications.");
    }
  }

  async function updateEventPreference(next: {
    missedCallEnabled: boolean;
    voicemailReadyEnabled: boolean;
  }) {
    const previous = { missedCallEnabled, voicemailReadyEnabled };
    setMissedCallEnabled(next.missedCallEnabled);
    setVoicemailReadyEnabled(next.voicemailReadyEnabled);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) throw new Error("This device is no longer subscribed.");
      await saveSubscription({ subscription, ...next });
      setMessage("Browser alert choices saved for this device.");
    } catch (error) {
      setMissedCallEnabled(previous.missedCallEnabled);
      setVoicemailReadyEnabled(previous.voicemailReadyEnabled);
      setMessage(error instanceof Error ? error.message : "Could not save browser alert choices.");
    }
  }

  const statusLabel = state === "on"
    ? "On for this device"
    : state === "enabling" || state === "checking"
      ? "Checking…"
      : state === "unavailable"
        ? "Relay setup required"
        : state === "unsupported"
          ? "Not supported here"
          : state === "denied"
            ? "Blocked by browser"
            : "Off for this device";

  return (
    <section className="push-notifications" aria-labelledby="push-notifications-title">
      <div className="push-notifications__head">
        <div>
          <p id="push-notifications-title" className="notification-preferences__title">
            Phone browser alerts
          </p>
          <p className="notification-preferences__note">
            Get a lock-screen alert without waiting for carrier texting approval. Off until you enable it on each device.
          </p>
        </div>
        <span className={`notification-preferences__text-status ${state === "on" ? "is-active" : ""}`}>
          {statusLabel}
        </span>
      </div>

      {!installed ? (
        <div className="push-notifications__install">
          <div>
            <strong>Install Relay on this phone</strong>
            <span>It opens like an app and makes alerts more reliable, especially on iPhone.</span>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={installApp}>
            {installAvailable ? "Install app" : "Show instructions"}
          </button>
        </div>
      ) : null}

      {state === "on" ? (
        <div className="push-notifications__events">
          <label>
            <input
              type="checkbox"
              checked={missedCallEnabled}
              onChange={(event) => updateEventPreference({
                missedCallEnabled: event.target.checked,
                voicemailReadyEnabled,
              })}
            />
            New missed calls
          </label>
          <label>
            <input
              type="checkbox"
              checked={voicemailReadyEnabled}
              onChange={(event) => updateEventPreference({
                missedCallEnabled,
                voicemailReadyEnabled: event.target.checked,
              })}
            />
            Voicemail ready
          </label>
        </div>
      ) : null}

      <div className="push-notifications__actions">
        {state === "on" ? (
          <button className="btn btn-secondary btn-sm" type="button" onClick={disablePush}>
            Turn off on this device
          </button>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={enablePush}
            disabled={state === "checking" || state === "enabling" || state === "unsupported" || state === "unavailable"}
          >
            {state === "enabling" ? "Enabling…" : "Turn on browser alerts"}
          </button>
        )}
        {message ? <p className="push-notifications__message" role="status">{message}</p> : null}
      </div>
    </section>
  );
}
