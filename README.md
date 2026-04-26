# Relay NW

Relay NW is a small missed-call SMS follow-up MVP for one local home services business.

Relay NW supports two call flows:

- `CALL_MODE=forwarding`: the business keeps its existing public number and uses conditional call forwarding to send missed calls to Relay NW.
- `CALL_MODE=direct`: customers call the Twilio number directly, and Relay NW forwards the call to the owner's real phone.

In both modes, Relay NW sends one automatic SMS with the intake link and saves the lead in Supabase when a call is missed.

This app is intentionally single-business. No accounts, billing, CRM, shared inbox, business-hours logic, or multi-tenant support.

## Day-One Setup Checklist

1. Create a Supabase project and run `supabase.sql` in the Supabase SQL Editor.
2. Create a Twilio account and buy or choose one Twilio phone number. This is the Relay NW recovery number.
3. Complete Twilio A2P 10DLC registration before expecting US SMS to deliver reliably.
4. Create `.env.local` from `.env.example` and fill in every required value.
5. Run locally with `npm install` and `npm run dev`.
6. For local Twilio testing, run `ngrok http 3000`.
7. Set `APP_BASE_URL` and `INTAKE_URL` to the ngrok or deployed public URL.
8. In Twilio, configure the phone number's Voice webhook to `APP_BASE_URL/api/twilio/voice`.
9. In Twilio, configure the phone number's Messaging webhook to `APP_BASE_URL/api/twilio/sms`.
10. Use HTTP `POST` for both Twilio webhooks.
11. For `CALL_MODE=direct`, make a real test call from a separate phone and let the owner's phone ring without answering.
12. For `CALL_MODE=forwarding`, configure the owner's existing number to forward busy/no-answer calls to the Twilio number, then make a missed-call test to the existing number.
13. Confirm the caller receives the SMS and the lead appears in `/leads`.
14. Reply to the SMS and confirm the owner receives the forwarded reply.

For the customer-by-customer onboarding checklist, see `docs/customer-setup.md`.

## Core Flow

### Direct Mode

1. Customer calls the Twilio business number.
2. Twilio posts to `/api/twilio/voice`.
3. Relay NW validates the Twilio signature.
4. Relay NW returns TwiML with `<Dial>` to forward the call to `OWNER_PHONE_NUMBER`.
5. `<Dial>` times out after `DIAL_TIMEOUT_SECONDS`, defaulting to 18 seconds.
6. Twilio posts the dial result to `/api/twilio/voice-status`.
7. If `DialCallStatus` is `no-answer`, `busy`, `failed`, or `canceled`, Relay NW creates a missed-call lead and sends the SMS.
8. If `DialCallStatus` is `completed` or `answered`, Relay NW does nothing.
9. The owner reviews leads at `/leads`.

### Forwarding Mode

1. Customer calls the business's existing number.
2. If the owner does not answer, is busy, or is unreachable, the carrier forwards the call to the Twilio number.
3. Twilio posts to `/api/twilio/voice`.
4. Relay NW treats the forwarded call as a missed-call lead immediately.
5. Relay NW sends the missed-call SMS when the number is eligible and records the SMS status.
6. Relay NW returns a short TwiML message and hangs up.
7. The owner reviews leads at `/leads`.

## Pages And Routes

- `/` setup/status home page
- `/intake` public intake form
- `/leads` password-protected lead inbox
- `/api/intake` intake form submission
- `/api/leads/[id]` lead status update
- `/api/twilio/voice` Twilio incoming call webhook
- `/api/twilio/voice-status` Twilio dial result webhook
- `/api/twilio/dial-status` Twilio dial result webhook alias
- `/api/twilio/recording` Twilio voicemail recording callback
- `/api/twilio/sms` Twilio inbound SMS webhook
- `/api/twilio/sms-status` Twilio outbound SMS delivery callback

## Environment Variables

Required:

- `BUSINESS_NAME`: business name used in the missed-call SMS
- `CALL_MODE`: `forwarding` to keep the existing business number, or `direct` to make the Twilio number the main call number
- `INTAKE_URL`: public URL for `/intake`
- `SCHEDULING_URL`: existing scheduling link for the business
- `LEADS_PASSWORD`: shared password for `/leads`
- `LEADS_COOKIE_SECRET`: long random secret used to sign the `/leads` session cookie
- `APP_BASE_URL`: public app URL used for Twilio callbacks and signature validation
- `TWILIO_ACCOUNT_SID`: Twilio account SID
- `TWILIO_AUTH_TOKEN`: Twilio auth token, server-only
- `TWILIO_PHONE_NUMBER`: Twilio-owned number customers call
- `OWNER_PHONE_NUMBER`: owner's real phone number
- `SUPABASE_URL`: Supabase project URL
- `NEXT_PUBLIC_SUPABASE_URL`: same Supabase project URL, kept for Next.js compatibility
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key, server-only

Optional:

- `SMS_TEMPLATE`: overrides the default SMS template
- `MISSED_CALL_VOICE_MESSAGE`: overrides what callers hear in `CALL_MODE=forwarding` before Twilio hangs up
- `MISSED_CALL_VOICE_NAME`: defaults to `Polly.Joanna-Neural` for a less robotic Twilio voice
- `MISSED_CALL_GREETING_AUDIO_URL`: optional public MP3/WAV URL; if set, Twilio plays it instead of text-to-speech before recording voicemail
- `VOICEMAIL_MAX_SECONDS`: defaults to `60`; maximum caller voicemail length in seconds
- `DIAL_TIMEOUT_SECONDS`: defaults to `18`
- `MISSED_CALL_SMS_COOLDOWN_HOURS`: defaults to `24`; prevents repeated missed-call texts to the same caller inside this window
- `ALLOW_UNSIGNED_TWILIO_WEBHOOKS`: defaults to `false`; use `true` only for local manual webhook testing, never production

Use phone numbers in E.164 format, like `+12065551234`.

For early customers, `CALL_MODE=forwarding` is the recommended product direction because the business can keep its existing number. Use `CALL_MODE=direct` when a business is willing to make the Twilio number its public number or when you want the simplest controlled test.

Default SMS template:

```text
Hi, this is {BUSINESS_NAME} - sorry we missed your call. Book or reply here: {INTAKE_URL}. Reply STOP to opt out.
```

Supported template variables:

- `{BUSINESS_NAME}`
- `{INTAKE_URL}`
- `{SCHEDULING_URL}`

Default forwarding voice message:

```text
Thanks for calling. Sorry we missed you. We will text you shortly. Please leave a quick message after the tone.
```

In `CALL_MODE=forwarding`, Relay plays the greeting and then records a short voicemail. Twilio posts the recording to `/api/twilio/recording`, and the lead inbox shows the voicemail on the matching missed-call lead.

## Database Setup

Open Supabase SQL Editor and run:

```sql
-- See supabase.sql for the complete current schema.
```

The schema includes:

- `leads`: intake and missed-call leads
- `webhook_events`: basic Twilio webhook logs for debugging
- `opt_outs`: phone numbers that replied STOP/UNSUBSCRIBE/CANCEL/END/QUIT
- `inbound_messages`: deduped inbound SMS replies from customers

`leads.call_sid` is unique when present. This prevents Twilio retries from creating duplicate missed-call leads or sending duplicate SMS messages.
`leads.twilio_message_sid` is unique when present. This lets SMS delivery callbacks update the matching lead.

## Local Development

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

You can test these locally without Twilio:

- Home page
- Intake form
- Supabase lead saving from `/intake`
- Leads page password gate
- Lead status changes

## Twilio Local Testing With Ngrok

Twilio cannot call `localhost` directly. Use ngrok:

```bash
ngrok http 3000
```

If ngrok gives:

```text
https://abc123.ngrok-free.app
```

Set these in `.env.local`:

```env
APP_BASE_URL="https://abc123.ngrok-free.app"
INTAKE_URL="https://abc123.ngrok-free.app/intake"
```

Restart `npm run dev`.

In Twilio Console, set the phone number's Voice webhook to:

```text
https://abc123.ngrok-free.app/api/twilio/voice
```

Use method `POST`.

Set the phone number's Messaging webhook to:

```text
https://abc123.ngrok-free.app/api/twilio/sms
```

Use method `POST`.

## Twilio Notes

- In forwarding mode, configure the business's existing carrier number to forward missed, busy, or unreachable calls to the Twilio number. Exact steps vary by carrier.
- Forwarding mode may miss callers who hang up before the carrier forwards the call. The honest promise is "recover more missed calls without changing your number," not "capture every abandoned call."
- `DIAL_TIMEOUT_SECONDS` defaults to 18 seconds to reduce the chance that the owner's carrier voicemail answers first.
- Shorter timeout means more false missed calls.
- Longer timeout means voicemail is more likely to answer, causing Twilio to report a connected call.
- `MISSED_CALL_SMS_COOLDOWN_HOURS` prevents repeat callers from receiving the same missed-call SMS over and over. Repeat missed calls still create leads; they are marked as recently texted.
- Relay NW tries to show the original caller as the forwarded caller ID. Twilio/carrier caller ID rules may affect what the owner actually sees.
- Before using this for real US business texting, complete Twilio A2P 10DLC brand/campaign registration. Use a customer-care style use case and include a sample message matching the app's SMS template. Without registration, Twilio/carriers can reject outbound SMS as coming from an unregistered number.

## Deployment

The simplest deployment path is Vercel:

1. Push this repo to GitHub.
2. Import the repo into Vercel.
3. Add all `.env.example` variables in Vercel Project Settings.
4. Deploy.
5. Set `APP_BASE_URL` to the deployed app URL, like `https://relay-nw.vercel.app`.
6. Set `INTAKE_URL` to `https://relay-nw.vercel.app/intake`.
7. Set Twilio's Voice webhook to `https://relay-nw.vercel.app/api/twilio/voice`.
8. Set Twilio's Messaging webhook to `https://relay-nw.vercel.app/api/twilio/sms`.
9. Keep `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` unset or `false` in production.

## Security Notes

- `/leads` uses one shared password.
- The `/leads` cookie is signed and HttpOnly; it does not store the raw password.
- There is no auth system.
- Twilio webhooks require a valid `X-Twilio-Signature` unless `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true` is explicitly set for local testing.
- Inbound SMS replies are forwarded to the owner phone number.
- STOP/UNSUBSCRIBE/CANCEL/END/QUIT replies are recorded in `opt_outs`.
- Supabase writes happen server-side with the service role key.
- `.env.local` must never be committed.
- This MVP is intended for non-healthcare businesses only.
- The intake form includes consent language.
- The SMS includes opt-out language.

## Not In V1

- Billing
- CRM automation
- Shared inbox
- Business-hours logic
- Scheduling engine
- Multi-business support
- User accounts
