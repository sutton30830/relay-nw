// Which number Relay may text the OWNER from. Owner alerts are Relay
// notifying its own consenting customer, so they can ride Relay's platform
// number (registered under Relay's own A2P brand) while the customer's own
// campaign is still with the carriers. The platform number is never used to
// text callers: that traffic stays on the customer's number and its A2P gate.

export type OwnerAlertSender = {
  from: string;
  channel: "account_number" | "platform_number";
};

export function resolveOwnerAlertSender(input: {
  smsEnabled: boolean;
  twilioPhoneNumber: string | null | undefined;
  ownerPhoneNumber: string | null | undefined;
  platformAlertNumber: string | null | undefined;
}): OwnerAlertSender | null {
  if (!input.ownerPhoneNumber) return null;

  // Prefer the account's own number once its campaign is approved and the
  // owner has turned texting on, so owner alerts and customer texts share a
  // sender the owner already recognises.
  if (input.smsEnabled && input.twilioPhoneNumber) {
    return { from: input.twilioPhoneNumber, channel: "account_number" };
  }

  const platform = input.platformAlertNumber?.trim();
  if (platform) {
    return { from: platform, channel: "platform_number" };
  }

  return null;
}

export function ownerTextAlertsAvailable(input: {
  smsEnabled: boolean;
  twilioPhoneNumber: string | null | undefined;
  ownerPhoneNumber: string | null | undefined;
  platformAlertNumber: string | null | undefined;
}) {
  return resolveOwnerAlertSender(input) !== null;
}
