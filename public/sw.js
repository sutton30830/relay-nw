/* global self */

const DEFAULT_URL = "/leads";

self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() };
  }

  const title = payload.title || "Relay NW";
  const url = typeof payload.url === "string" ? payload.url : DEFAULT_URL;
  const options = {
    body: payload.body || "You have a new Relay notification.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || "relay-owner-alert",
    data: { url },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || DEFAULT_URL, self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));

    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }

    return self.clients.openWindow(targetUrl);
  })());
});
