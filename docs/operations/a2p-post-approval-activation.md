# A2P Post-Approval Activation

Use this runbook only after Twilio has approved the customer's campaign. It is
an evidence checklist, not permission for Relay to turn texting on for the
customer.

## Prepare now

- Keep `sms_enabled=false` while carrier registration is pending.
- Confirm the business profile, hours, coverage rules, notification choices,
  voicemail greeting, and exact missed-call text.
- Capture the pilot baseline with `npm run baseline:pilot -- <slug>`.
- Record any comp or billing exception before activation. A comped account must
  not collect a card, start a Stripe trial, or create a subscription.
- Do not create approval, delivery, or owner-consent evidence by hand.

## Approval preflight

1. Run `npm run inspect:a2p -- <slug>` and confirm the Messaging Service,
   campaign, and customer Relay number agree with Twilio.
2. Sync from Twilio in Operations. Relay must show `approved` with a current
   last-sync time; a screenshot or Twilio console status alone is not enough.
3. Confirm the Relay number is SMS-capable and belongs to the approved
   Messaging Service sender pool.
4. Re-read the saved missed-call message with the owner. It must identify the
   business, accurately describe the follow-up, and preserve STOP/HELP behavior.
5. Review owner email/text notification choices separately. Notification
   preferences do not authorize customer-facing automatic texts.

## Owner authorization and activation

The owner must sign in to Relay and turn **Automatic texting** from OFF to ON.
On first activation, Relay requires a separate authorization checkbox stating
that Relay may automatically text missed callers using the message saved on the
page. Relay records `texting.activation_approved` with the authenticated owner,
account, and time.

- Do not turn the switch on through Operations, SQL, or on the owner's behalf.
- Do not treat A2P approval as owner authorization; approval only makes the
  control available.
- Turning texting off remains immediate and does not require confirmation.
- If the owner-authorization audit event is missing, launch certification must
  fail even when `sms_enabled=true`.

## Controlled live test

Use one clearly identified test caller and complete this sequence once:

1. Place a real unanswered call to the customer's published number.
2. Confirm exactly one tenant-scoped lead with the correct call time.
3. Leave a clear service request. Confirm recording playback, full transcript,
   and a grounded summary on that same lead.
4. Confirm the automatic text exactly matches the approved copy and wait for
   Twilio's real `delivered` callback. `queued` or `sent` is not delivery.
5. Reply from the caller's phone, verify the inbound message on the same lead,
   then send one Relay reply and confirm delivery.
6. Use one approved non-SMS test number and retain Twilio error `30006`. Do not
   repeatedly test an unknown person's landline.
7. Send the owner notification test. Provider acceptance is not enough; the
   owner confirms receipt while authenticated.
8. Mark the test lead booked, enter a value, and confirm Reports updates.
9. Have the authenticated owner approve go-live only after all earlier checks
   pass.
10. Run and retain:

   ```text
   npm run verify:account -- <slug>
   npm run verify:launch -- <slug>
   ```

## Failure and rollback

If any customer-facing text is duplicated, misrouted, incorrectly worded, or
not provider-confirmed, the owner turns **Automatic texting** OFF immediately.
Leave call capture and voicemail running, record the affected lead/message SID,
and investigate before another live test. Do not resend automatically and do
not alter A2P status to conceal the failure.

For a verifier failure, resolve the named evidence gap. Never insert a synthetic
audit, delivery, owner-confirmation, or go-live row to make the check pass.
