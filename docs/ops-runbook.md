# Relay NW Ops Runbook

Use this when Relay NW is live for a business and something important may have failed. The goal is simple: protect the missed-call recovery loop, notify the right person, and avoid silently losing caller data.

## First Response

1. Open `/ops` for the affected account.
2. Search by `CallSid`, `MessageSid`, `RecordingSid`, caller last 4, or webhook source.
3. Open the lead inbox and confirm whether the caller has a lead.
4. Check the lead card for `sms_status`, voicemail status, transcript status, and any visible error.
5. If caller follow-up may have failed, tell the owner to call the lead manually.

## Core Loop Checks

For every live account, the healthy path is:

1. Twilio voice or dial-status webhook resolves to the account.
2. A lead is created once for the missed call.
3. Automatic SMS sends only when A2P is approved and `sms_enabled=true`.
4. Twilio SMS status callback updates the lead/message row.
5. Inbound caller replies are stored and forwarded to the owner.
6. Recording callback attaches voicemail to the lead.
7. Voicemail transcription completes or fails visibly.

Run `npm run test:activation` locally before high-risk releases. This is deterministic proof of the app flow, not proof that carriers delivered a real SMS.

## Failure Playbooks

### SMS Failed, Undelivered, or Not Sent

- If `sms_status=failed` or `undelivered`, tell the owner to call the lead.
- Check `/ops` for `twilio_sms_status` and the `MessageSid`.
- If `sms_status=skipped_disabled`, confirm whether the owner intentionally paused automatic texting.
- If A2P is not approved, keep SMS off and treat the account as calls-ready only.
- If Twilio accepted the SMS but the lead update failed, wait for the status callback to reconcile through the messages table. If it does not reconcile, search `/ops` by `MessageSid`.

### Missing Lead

- Search `/ops` by `CallSid` and caller last 4.
- If the webhook is unresolved, verify the account's Twilio number routing and `account_phone_numbers` row.
- If a lead was not created, call the owner and manually capture the caller details from Twilio if available.

### Voicemail or Transcription Failed

- If a recording exists but the summary failed, the owner can still listen to the voicemail.
- Check `/ops` for `twilio_recording`.
- If transcription failed transiently, run the retry cron or wait for the scheduled retry.
- If Twilio no longer has the recording, mark the lead as needing manual follow-up and do not promise recovery.

### Alert Email Not Received

- Check `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `ADMIN_ALERT_EMAIL`, and Sentry.
- Admin operational alerts are the backstop for SMS, persistence, and transcription failures.
- If alerting is down, monitor `/ops` manually for active pilot accounts until fixed.

## Privacy and Retention

- Do not paste full caller messages, transcripts, or recordings into support notes unless needed to resolve an issue.
- Use caller last 4, `CallSid`, `MessageSid`, and `RecordingSid` for debugging when possible.
- Webhook debug logs are sanitized and pruned by `WEBHOOK_EVENT_RETENTION_DAYS`.
- Inbound SMS bodies are pruned by `INBOUND_MESSAGE_RETENTION_DAYS`.
- Voicemail recordings, transcripts, and lead records are retained until manually deleted or until automated recording retention is implemented.
- For a deletion request, identify the account, lead, caller phone, recording SID, message SIDs, and any opt-out rows before deleting.

## Release Checklist

Before handing a business live access:

1. `npm run verify:account -- <slug>`
2. `npm run test:activation`
3. One real missed-call test through Twilio.
4. Confirm `/ops` shows the voice/dial-status, SMS status, inbound reply, and recording events.
5. Confirm privacy and terms links are visible from intake/setup flows.
