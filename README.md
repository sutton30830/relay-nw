# Relay NW

Relay NW is a missed-call recovery SaaS for one-truck home-service businesses. It is currently built for manually provisioned pilot accounts, not fully self-serve signup.

The deployed billing and Operations contract is documented in
`docs/strategy/BILLING-OPERATIONS-SIMPLIFICATION.md`. Stripe owns delayed
trials and billing truth; Relay derives its Operations queue from independent
Calls, Texting, Billing, and blocker facts.

Relay NW supports two call flows:

- `CALL_MODE=forwarding`: the business keeps its existing public number and uses conditional call forwarding to send missed calls to Relay NW.
- `CALL_MODE=direct`: customers call the Twilio number directly, and Relay NW forwards the call to the owner's real phone.

In both modes, Relay NW saves the missed call in an account-scoped Supabase inbox and sends one automatic SMS only when the account is configured, A2P is approved, and the owner has automatic texting turned on.

The product is multi-account at the data and auth layer, while early customers are still onboarded by a Relay operator. Stripe Checkout, Customer Portal, signed webhooks, and reconciliation own customer billing. Relay keeps technical setup, A2P status, and commercial exceptions independent.

## Day-One Setup Checklist

1. Create a Supabase project and run `supabase.sql` in the Supabase SQL Editor.
2. Create or connect a Twilio account and assign each pilot account a Relay NW recovery number.
3. Complete Twilio A2P 10DLC registration before expecting US SMS to deliver reliably.
4. Create `.env.local` from `.env.example` and fill in the platform-level values.
5. Run locally with `npm install` and `npm run dev`.
6. For local Twilio testing, run `ngrok http 3000`.
7. Set `APP_BASE_URL` and `INTAKE_URL` to the ngrok or deployed public URL.
8. Provision each customer account with `npm run provision:account`.
9. Verify each customer account with `npm run verify:account -- <slug>`.
10. In Twilio, configure the account's phone number Voice webhook to `APP_BASE_URL/api/twilio/voice`.
11. In Twilio, configure the account's phone number Messaging webhook to `APP_BASE_URL/api/twilio/sms`.
12. Use HTTP `POST` for both Twilio webhooks.
13. For `CALL_MODE=forwarding`, help the customer enable conditional forwarding from their existing number to Relay.
14. Confirm the first real missed call appears once in `/leads` and automatically marks call capture live.
15. Complete A2P registration in Twilio; keep automatic texting off until approved.
16. Confirm the caller receives SMS only when texting is approved and enabled.
17. Explain the $150 setup fee, $99 monthly plan, and Stripe-hosted billing controls.

For the customer-by-customer workflow, see `docs/onboarding-runbook.md` and
`docs/customer-setup.md`.

For production access, credential rotation, backup/restore drills, operator
offboarding, incident ownership, and the value-free secrets inventory, see
`docs/operations/README.md`.

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
- `/leads` Supabase-authenticated lead inbox
- `/login` owner email/password sign-in, with setup/reset and magic-link fallback
- `/account/password` authenticated password setup/reset page
- `/setup` authenticated call setup/status page
- `/settings` authenticated account settings
- `/reports` authenticated owner reporting
- `/ops` Relay operator-only Work queue, including new setup requests
- `/ops/accounts` searchable account directory
- `/ops/accounts/[id]` independent Calls, Texting, Billing, and blocker workspace
- `/ops/setup-requests` retired assisted-onboarding URL (redirects to Work queue)
- `docs/ops-runbook.md` operational runbook (kept outside the primary app navigation)
- `/api/intake` intake form submission
- `/api/leads/[id]` lead status update
- `/api/twilio/voice` Twilio incoming call webhook
- `/api/twilio/voice-status` Twilio dial result webhook
- `/api/twilio/dial-status` Twilio dial result webhook alias
- `/api/twilio/recording` Twilio voicemail recording callback
- `/api/twilio/sms` Twilio inbound SMS webhook
- `/api/twilio/sms-status` Twilio outbound SMS delivery callback
- `/api/billing/setup-fee` owner-only $150 Stripe setup Checkout
- `/api/billing/payment-method` owner-only no-charge Stripe card setup
- `/api/billing/checkout` owner-only Stripe subscription restart Checkout
- `/api/billing/portal` owner-only Stripe Customer Portal
- `/api/ops/blocker` audited operator blocker ownership
- `/api/ops/calls` audited operator call hold/resume control
- `/api/stripe/webhook` signed Stripe billing synchronization

## Environment Variables

Required:

- `BUSINESS_NAME`: business name used in the missed-call SMS
- `CALL_MODE`: `forwarding` to keep the existing business number, or `direct` to make the Twilio number the main call number
- `INTAKE_URL`: public URL for `/intake`
- `SCHEDULING_URL`: existing scheduling link for the business
- `SMS_ENABLED`: defaults to `false`; set to `true` only after A2P 10DLC is approved and you are ready for real outbound texts
- `APP_BASE_URL`: public app URL used for Twilio callbacks and signature validation
- `TWILIO_ACCOUNT_SID`: Twilio account SID
- `TWILIO_AUTH_TOKEN`: Twilio auth token, server-only
- `TWILIO_PHONE_NUMBER`: Twilio-owned number customers call
- `OWNER_PHONE_NUMBER`: owner's real phone number
- `SUPABASE_URL`: Supabase project URL
- `NEXT_PUBLIC_SUPABASE_URL`: same Supabase project URL, kept for Next.js compatibility
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key used for owner auth
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key, server-only

Optional:

- `SMS_TEMPLATE`: overrides the default SMS template
- `MISSED_CALL_VOICE_MESSAGE`: overrides what callers hear in `CALL_MODE=forwarding` before Twilio hangs up
- `MISSED_CALL_VOICE_NAME`: defaults to `Polly.Joanna-Neural` for a less robotic Twilio voice
- `MISSED_CALL_GREETING_AUDIO_URL`: optional public MP3/WAV URL; if set, Twilio plays it instead of text-to-speech before recording voicemail
- `VOICEMAIL_MAX_SECONDS`: defaults to `60`; maximum caller voicemail length in seconds
- `DIAL_TIMEOUT_SECONDS`: defaults to `18`
- `MISSED_CALL_SMS_COOLDOWN_HOURS`: defaults to `24`; prevents repeated missed-call texts to the same caller inside this window
- `WEBHOOK_EVENT_RETENTION_DAYS`: defaults to `30`; the daily retention job deletes older sanitized webhook diagnostics
- `INBOUND_MESSAGE_RETENTION_DAYS`: defaults to `90`; the daily retention job removes older inbound SMS bodies from both Relay message tables and requests deletion of the Twilio Message resource
- `MONITORING_ACTIVITY_WINDOW_HOURS`: defaults to `24`; recent call, SMS, and webhook health window
- `MONITORING_MISSING_LEAD_GRACE_MINUTES`: defaults to `5`; delay before a missed call without a lead is actionable
- `MONITORING_MISSING_SMS_GRACE_MINUTES`: defaults to `5`; delay before an eligible pending auto-text is actionable
- `MONITORING_SMS_FAILURE_RATE_PERCENT`: defaults to `20`; warning threshold after the minimum sample
- `MONITORING_SMS_FAILURE_MINIMUM_ATTEMPTS`: defaults to `3`; prevents noisy rates from one-off failures
- `MONITORING_DAILY_CRON_STALE_HOURS`: defaults to `36`; daily job check-in threshold
- `MONITORING_WEEKLY_CRON_STALE_HOURS`: defaults to `192`; weekly digest check-in threshold
- `OPENAI_API_KEY`: optional; enables voicemail transcription and quick summaries from the lead drawer
- `OPENAI_TRANSCRIPTION_MODEL`: optional; defaults to `gpt-4o-transcribe`; only confidence-capable GPT-4o transcription models are accepted
- `AUTH_RATE_LIMIT_SALT`: optional dedicated HMAC secret for durable authentication rate-limit identifiers; defaults to the server-only Supabase service-role key
- `OPENAI_SUMMARY_MODEL`: optional; defaults to `gpt-4o-mini`
- `WEB_PUSH_PUBLIC_KEY` and `WEB_PUSH_PRIVATE_KEY`: optional VAPID key pair; enables owner-opted-in browser alerts for new missed calls and completed voicemail summaries without depending on A2P approval
- `WEB_PUSH_CONTACT`: optional VAPID contact URI; defaults to `mailto:relaynw@gmail.com`
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
Thanks for calling. Sorry we missed you. We will text you shortly. Please leave a quick recorded message after the tone.
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
- `owner_push_subscriptions`: device-specific, account- and user-scoped browser alert subscriptions; direct client access is denied by RLS
- `inbound_messages`: deduped inbound SMS replies from customers

`leads.call_sid` is unique when present. This prevents Twilio retries from creating duplicate missed-call leads or sending duplicate SMS messages.
`leads.twilio_message_sid` is unique when present. This lets SMS delivery callbacks update the matching lead.

Relay does not use synthetic forwarding or SMS tests. A valid signed missed call that creates a new lead is the proof that call capture is live.

### Tenant Account ID Backfill

Before applying the latest `supabase.sql` constraints to an existing database, deploy the code that always writes `account_id`, then run the dry-run backfill:

```bash
npm run backfill:account-ids -- --slug=relay-nw
```

If the dry run reports NULL rows in `leads`, `opt_outs`, or `inbound_messages`, backfill them to the house account:

```bash
npm run backfill:account-ids -- --slug=relay-nw --apply
```

Run the dry run again and confirm those tables show zero blocking NULL rows, then apply `supabase.sql`. `webhook_events.account_id` intentionally remains nullable because unresolved Twilio webhooks are logged there with sanitized payloads and no tenant writes.

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
- Supabase Auth login and protected leads redirect
- Lead status changes

## Webhook Simulator

For local webhook smoke tests, temporarily set this in `.env.local`:

```env
ALLOW_UNSIGNED_TWILIO_WEBHOOKS="true"
```

Then run the app locally and post simulated Twilio payloads:

```bash
npm run dev
npm run simulate -- missed-call
npm run simulate -- answered-call
npm run simulate -- recording
npm run simulate -- inbound-sms
npm run simulate -- sms-status
```

Set `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` back to `false` after local testing. Production refuses to start if unsigned Twilio webhooks are enabled.

`missed-call` can attempt to send an outbound SMS if your local Twilio credentials are real. Use Twilio test credentials or expect SMS failure until A2P 10DLC is approved.

## Verification Commands

Before pushing changes, run:

```bash
npm run typecheck
npm run build
```

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
9. Set Stripe's webhook endpoint to `https://relay-nw.vercel.app/api/stripe/webhook`.
10. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, and `STRIPE_SETUP_FEE_PRICE_ID` before using Checkout.
11. Keep `ALLOW_UNSIGNED_TWILIO_WEBHOOKS` unset or `false` in production.

## Security Notes

- `/leads` and `/ops` require Supabase Auth. Email/password is the primary owner sign-in path; magic links remain a fallback.
- Human access is scoped through `account_users`, then resolved to one selected tenant account. Users with multiple memberships require an explicit selected account before APIs proceed.
- Supabase Auth session cookies are refreshed in middleware so active owners are less likely to be bounced back to `/login`.
- The public setup form has a small per-IP throttle to reduce spam submissions.
- Twilio webhooks require a valid `X-Twilio-Signature` unless `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true` is explicitly set for local testing.
- Webhook event logs store sanitized payload summaries. Full phone numbers, SMS bodies, and recording URLs are not stored in `webhook_events`.
- Old webhook events and inbound message bodies are pruned according to the retention environment variables.
- Inbound SMS replies are forwarded to the owner phone number.
- STOP/UNSUBSCRIBE/CANCEL/END/QUIT replies are recorded in `opt_outs`.
- Supabase writes happen server-side with the service role key.
- `.env.local` must never be committed.
- This MVP is intended for non-healthcare businesses only.
- The intake form includes consent language.
- The SMS includes opt-out language.

## Not In V1

- CRM automation
- Shared inbox
- Scheduling engine
- Fully self-serve signup and provisioning
