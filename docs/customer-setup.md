# Relay NW Customer Setup Checklist

Use this checklist for every early customer. Relay NW is multi-account in the database and auth layer, but onboarding is still assisted by an operator until fully self-serve setup ships.

## 1. Track the Setup Request

1. Open `/ops/setup-requests` from the Relay NW house account.
2. Filter for `New` requests.
3. Contact the prospect and mark the request `Contacted`.
4. When their account is live, mark the request `Onboarded`.
5. If they are not a fit or stop responding, mark the request `Closed`.

Do not create sales inquiries as tenant leads. The public intake form writes to `setup_requests`, not a customer's missed-call inbox.

## 2. Collect the Basics

- Business name for SMS and greeting copy.
- Existing public business phone number.
- Owner email for Supabase Auth.
- Owner phone number for call-back links and forwarded replies.
- Relay NW Twilio recovery number.
- Public intake form URL.
- Call mode: `forwarding` for most early customers, `direct` only when the Twilio number is their public number.
- Custom greeting audio URL, if they recorded one.

## 3. Provision the Account

Provision the account with the script so account-scoped rows stay consistent:

```bash
npm run provision:account
```

The script should create or update the account, account settings, account phone number, and owner account-user row. After provisioning, create or invite the owner through Supabase Auth if needed.

Then verify:

```bash
npm run verify:account -- <slug>
```

Treat verification output as the source of truth:

- `Live · Auto-text on` means calls and automatic texting are ready.
- `Live · Auto-text paused` means call capture is ready, but the owner intentionally paused automatic texting.
- `Calls ready · Texting not ready` means call capture can be tested, but texting needs A2P/configuration attention.
- `Setup needed` means routing or core configuration is incomplete.

## 4. Configure Twilio

On the customer's Relay NW Twilio phone number:

- Voice webhook: `APP_BASE_URL/api/twilio/voice`
- Voice method: `POST`
- Messaging webhook: `APP_BASE_URL/api/twilio/sms`
- Messaging method: `POST`

Confirm the number is present in `account_phone_numbers` for the correct account. If A2P 10DLC is not approved yet, calls and voicemail can still be tested, but outbound SMS should not be treated as production-ready.

## 5. Configure Conditional Call Forwarding

The customer usually keeps their existing number. Their carrier forwards missed, busy, or unreachable calls to the Relay NW recovery number.

Use `/setup` with the owner so the app can show carrier-aware forwarding guidance and run the listening test. Carrier codes vary, and carrier apps, landlines, VoIP providers, and regional carriers may use different steps.

For many US mobile carriers, these are useful starting points:

- No answer: `*61*RELAY_NUMBER#`
- Busy: `*67*RELAY_NUMBER#`
- Unreachable: `*62*RELAY_NUMBER#`

Replace `RELAY_NUMBER` with the Relay NW recovery number, including `1` for US numbers.

## 6. Run One Real Test

Test with the customer watching:

1. Run `npm run verify:account -- <slug>` before the call.
2. In `/setup`, start the forwarding/listening test.
3. Call the customer's existing number from a separate phone.
4. Do not answer.
5. Confirm the call forwards to Relay NW.
6. Confirm the greeting plays and discloses recording.
7. Leave a short voicemail.
8. Confirm the lead appears in `/leads`.
9. Confirm the voicemail appears on the lead.
10. Confirm SMS status is visible on the lead.
11. Reply to the SMS, if texting is approved/on, and confirm the owner receives the forwarded reply.
12. Open `/ops` and confirm the call, recording, SMS status, and inbound reply events are visible.

If A2P is pending or automatic texting is paused, the lead should still appear in the inbox, but callers should not receive an automatic text.

## 7. Go-Live Check

Before charging for a live account:

- Account verification passes or only warns that automatic texting is intentionally paused.
- A2P 10DLC registration is approved before promising automatic SMS.
- One missed-call test succeeds.
- One voicemail recording test succeeds.
- One inbound SMS reply test succeeds when texting is on.
- `/ops` shows enough detail to explain the test call.
- The owner can sign in with email/password and knows how to reset their password.
- The owner understands automatic SMS can be paused without turning off call capture.
- The owner understands callers who hang up before forwarding reaches Relay NW may not be captured.
