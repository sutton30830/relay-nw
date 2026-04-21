# Relay NW

Relay NW is a small missed-call SMS follow-up MVP for one local home services business.

When a customer calls the business's Twilio number, Relay NW forwards the call to the owner's real phone. If the owner misses the call, Relay NW sends one automatic SMS with the intake link and saves the lead in Supabase.

This app is intentionally single-business. No accounts, billing, CRM, shared inbox, business-hours logic, or multi-tenant support.

## Day-One Setup Checklist

1. Create a Supabase project and run `supabase.sql` in the Supabase SQL Editor.
2. Create a Twilio account and buy or choose one Twilio phone number.
3. Create `.env.local` from `.env.example` and fill in every required value.
4. Run locally with `npm install` and `npm run dev`.
5. For local Twilio testing, run `ngrok http 3000`.
6. Set `APP_BASE_URL` and `INTAKE_URL` to the ngrok or deployed public URL.
7. In Twilio, configure the phone number's Voice webhook to `APP_BASE_URL/api/twilio/voice`.
8. In Twilio, configure the phone number's Messaging webhook to `APP_BASE_URL/api/twilio/sms`.
9. Use HTTP `POST` for both Twilio webhooks.
10. Make a real test call from a separate phone.
11. Let the owner's phone ring without answering.
12. Confirm the caller receives the SMS and the lead appears in `/leads`.
13. Reply to the SMS and confirm the owner receives the forwarded reply.

## Core Flow

1. Customer calls the Twilio business number.
2. Twilio posts to `/api/twilio/voice`.
3. Relay NW validates the Twilio signature.
4. Relay NW returns TwiML with `<Dial>` to forward the call to `OWNER_PHONE_NUMBER`.
5. `<Dial>` times out after `DIAL_TIMEOUT_SECONDS`, defaulting to 18 seconds.
6. Twilio posts the dial result to `/api/twilio/dial-status`.
7. If `DialCallStatus` is `no-answer`, `busy`, `failed`, or `canceled`, Relay NW creates a missed-call lead and sends the SMS.
8. If `DialCallStatus` is `completed` or `answered`, Relay NW does nothing.
9. The owner reviews leads at `/leads`.

## Pages And Routes

- `/` setup/status home page
- `/intake` public intake form
- `/leads` password-protected lead inbox
- `/api/intake` intake form submission
- `/api/leads/[id]` lead status update
- `/api/twilio/voice` Twilio incoming call webhook
- `/api/twilio/dial-status` Twilio dial result webhook
- `/api/twilio/sms` Twilio inbound SMS webhook

## Environment Variables

Required:

- `BUSINESS_NAME`: business name used in the missed-call SMS
- `INTAKE_URL`: public URL for `/intake`
- `SCHEDULING_URL`: existing scheduling link for the business
- `LEADS_PASSWORD`: shared password for `/leads`
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
- `DIAL_TIMEOUT_SECONDS`: defaults to `18`
- `MISSED_CALL_SMS_COOLDOWN_HOURS`: defaults to `24`; prevents repeated missed-call texts to the same caller inside this window

Use phone numbers in E.164 format, like `+12065551234`.

Default SMS template:

```text
Hi, this is {BUSINESS_NAME} - sorry we missed your call. Book or reply here: {INTAKE_URL}. Reply STOP to opt out.
```

Supported template variables:

- `{BUSINESS_NAME}`
- `{INTAKE_URL}`
- `{SCHEDULING_URL}`

## Database Setup

Open Supabase SQL Editor and run:

```sql
-- See supabase.sql for the complete current schema.
```

The schema includes:

- `leads`: intake and missed-call leads
- `webhook_events`: basic Twilio webhook logs for debugging
- `opt_outs`: phone numbers that replied STOP/UNSUBSCRIBE/CANCEL/END/QUIT

`leads.call_sid` is unique when present. This prevents Twilio retries from creating duplicate missed-call leads or sending duplicate SMS messages.

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

- `DIAL_TIMEOUT_SECONDS` defaults to 18 seconds to reduce the chance that the owner's carrier voicemail answers first.
- Shorter timeout means more false missed calls.
- Longer timeout means voicemail is more likely to answer, causing Twilio to report a connected call.
- `MISSED_CALL_SMS_COOLDOWN_HOURS` prevents repeat callers from receiving the same missed-call SMS over and over. Repeat missed calls still create leads; they are marked as recently texted.
- Relay NW tries to show the original caller as the forwarded caller ID. Twilio/carrier caller ID rules may affect what the owner actually sees.
- Before using this for real US business texting, complete Twilio A2P 10DLC brand/campaign registration. Use a customer-care style use case and include a sample message matching the app's SMS template.

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

## Security Notes

- `/leads` uses one shared password.
- There is no auth system.
- Twilio webhooks validate `X-Twilio-Signature`.
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
