# Relay NW Customer Setup Checklist

Use this checklist for every early customer. Keep setup hands-on until the flow has been tested with a real call.

## 1. Collect The Basics

- Business name for SMS and greeting copy.
- Existing public business phone number.
- Owner phone number for call-back links and forwarded replies.
- Relay NW Twilio phone number.
- Public intake form URL.
- Lead inbox password.
- Custom greeting audio URL, if they recorded one.

## 2. Configure The App

In Vercel production environment variables:

- `CALL_MODE=forwarding`
- `APP_BASE_URL=https://relay-nw.vercel.app`
- `INTAKE_URL=https://relay-nw.vercel.app/intake`
- `BUSINESS_NAME` set to the customer-facing business name
- `OWNER_PHONE_NUMBER` set to the owner phone in E.164 format, like `+12065551234`
- `TWILIO_PHONE_NUMBER` set to the Relay NW Twilio number
- `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` unset or `false`

After changing Vercel env vars, redeploy production.

## 3. Configure Twilio

On the Relay NW Twilio phone number:

- Voice webhook: `https://relay-nw.vercel.app/api/twilio/voice`
- Voice method: `POST`
- Messaging webhook: `https://relay-nw.vercel.app/api/twilio/sms`
- Messaging method: `POST`

If A2P 10DLC is not registered yet, calls and voicemail can still be tested, but outbound SMS may fail or be blocked.

## 4. Configure Conditional Call Forwarding

The customer keeps their existing number. Their carrier forwards missed, busy, or unreachable calls to the Relay NW Twilio number.

Carrier codes vary. For AT&T, these commonly work:

- No answer: `*61*TWILIO_NUMBER#`
- Busy: `*67*TWILIO_NUMBER#`
- Unreachable: `*62*TWILIO_NUMBER#`

Replace `TWILIO_NUMBER` with the Relay NW number, including `1` for US numbers.

## 5. Run One Real Test

Test with the customer watching:

1. Call the customer's existing number from a separate phone.
2. Do not answer.
3. Confirm the call forwards to Relay NW.
4. Confirm the greeting plays.
5. Leave a short voicemail.
6. Confirm the lead appears in `/leads`.
7. Confirm the voicemail appears on the lead.
8. Confirm SMS status is visible on the lead.

If A2P is not active, SMS may show failed because the number is unregistered. That is expected until registration is complete.

## 6. Go-Live Check

Before charging:

- A2P 10DLC registration is approved.
- One missed call test succeeds.
- One voicemail recording test succeeds.
- One inbound SMS reply test succeeds.
- The owner knows the lead inbox password.
- The owner understands that callers who hang up before forwarding may not be captured.
