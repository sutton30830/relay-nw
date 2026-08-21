export type NotificationChannels = {
  email: boolean;
  sms: boolean;
};

export type OwnerNotificationPreferences = {
  missedCall: NotificationChannels;
  voicemailReady: NotificationChannels;
  inboundReply: NotificationChannels;
  urgentVoicemailSms: boolean;
};

// These defaults exactly preserve the behavior that existed before owners
// could customize notifications.
export const DEFAULT_OWNER_NOTIFICATION_PREFERENCES: OwnerNotificationPreferences = {
  missedCall: { email: true, sms: true },
  voicemailReady: { email: true, sms: false },
  inboundReply: { email: true, sms: true },
  urgentVoicemailSms: true,
};

function booleanOrDefault(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeChannels(value: unknown, fallback: NotificationChannels): NotificationChannels {
  const channels = objectOrEmpty(value);
  return {
    email: booleanOrDefault(channels.email, fallback.email),
    sms: booleanOrDefault(channels.sms, fallback.sms),
  };
}

export function normalizeOwnerNotificationPreferences(
  value: unknown,
): OwnerNotificationPreferences {
  const preferences = objectOrEmpty(value);

  return {
    missedCall: normalizeChannels(
      preferences.missed_call ?? preferences.missedCall,
      DEFAULT_OWNER_NOTIFICATION_PREFERENCES.missedCall,
    ),
    voicemailReady: normalizeChannels(
      preferences.voicemail_ready ?? preferences.voicemailReady,
      DEFAULT_OWNER_NOTIFICATION_PREFERENCES.voicemailReady,
    ),
    inboundReply: normalizeChannels(
      preferences.inbound_reply ?? preferences.inboundReply,
      DEFAULT_OWNER_NOTIFICATION_PREFERENCES.inboundReply,
    ),
    urgentVoicemailSms: booleanOrDefault(
      preferences.urgent_voicemail_sms ?? preferences.urgentVoicemailSms,
      DEFAULT_OWNER_NOTIFICATION_PREFERENCES.urgentVoicemailSms,
    ),
  };
}

export function serializeOwnerNotificationPreferences(
  preferences: OwnerNotificationPreferences,
) {
  return {
    missed_call: preferences.missedCall,
    voicemail_ready: preferences.voicemailReady,
    inbound_reply: preferences.inboundReply,
    urgent_voicemail_sms: preferences.urgentVoicemailSms,
  };
}
