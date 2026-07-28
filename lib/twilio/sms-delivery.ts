export type SmsDeliveryIssue = {
  title: string;
  guidance: string;
  diagnostic: string;
};

const TWILIO_DELIVERY_ERRORS: Record<string, {
  label: string;
  guidance: string;
}> = {
  "30003": {
    label: "Unreachable destination handset",
    guidance: "The customer’s phone could not be reached. Call them or try again later.",
  },
  "30004": {
    label: "Message blocked",
    guidance: "The receiving carrier or phone blocked this text. Call the customer instead.",
  },
  "30005": {
    label: "Unknown destination handset",
    guidance: "The number may be invalid or disconnected. Verify it before trying again.",
  },
  "30006": {
    label: "Landline or unreachable carrier",
    guidance: "This may be a landline or a number that cannot receive texts. Call the customer instead.",
  },
  "30007": {
    label: "Message filtered",
    guidance: "A carrier filtered this text. Call the customer and verify the number before trying again.",
  },
  "30008": {
    label: "Unknown delivery error",
    guidance: "The carrier could not deliver this text. Call the customer or try again later.",
  },
};

export function twilioErrorCode(error: string | null | undefined) {
  return error?.match(/\b(?:21|30)\d{3}\b/)?.[0] ?? null;
}

export function smsDeliveryIssue(
  status: string | null | undefined,
  error: string | null | undefined,
): SmsDeliveryIssue | null {
  if (status !== "failed" && status !== "undelivered") {
    return null;
  }

  const code = twilioErrorCode(error);
  const known = code ? TWILIO_DELIVERY_ERRORS[code] : null;

  if (known) {
    return {
      title: "Text could not be delivered",
      guidance: known.guidance,
      diagnostic: `Twilio error ${code} · ${known.label}`,
    };
  }

  return {
    title: "Text could not be delivered",
    guidance: "The customer did not receive this text. Call them or verify the number before trying again.",
    diagnostic: code
      ? `Twilio error ${code}`
      : error
        ? `Twilio detail · ${error}`
        : "Twilio did not provide a specific error code.",
  };
}

export function smsDeliveryStatusLabel(status: string | null | undefined) {
  if (status === "queued" || status === "sending") return "Sending";
  if (status === "sent") return "Sent";
  if (status === "delivered") return "Delivered";
  if (status === "failed" || status === "undelivered") return "Not delivered";
  return null;
}
