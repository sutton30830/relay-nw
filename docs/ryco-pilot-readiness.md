# RYCO Pilot Readiness

Internal working record for the conversation with Ryen and the period while
Twilio reviews the messaging campaign.

## Baseline

Captured from production on **August 20, 2026 at 7:35 PM PT** with
`npm run baseline:pilot -- ryco-property-maintenance`.

| Measure | Baseline |
| --- | ---: |
| Missed calls captured | 28 |
| Voicemail recordings | 11 |
| Transcripts | 2 |
| Summaries | 0 |
| Existing transcripts eligible for summary recovery | 2 |
| Outbound messages | 0 |
| Caller replies | 0 |
| Response-time samples | 0 |
| Bookings | 0 |
| Known recovered value | $0 |

Calls are live and voicemail transcription is enabled. Automatic texting is
off. Relay currently records A2P as `not_started`; this is correct while Relay
completes its Twilio ISV application with Twilio Customer Support. There is no
RYCO campaign to synchronize yet, so there is no carrier profile or last-sync
timestamp. No owner notification has been sent or confirmed, and the owner has
not approved go-live.

This baseline does **not** treat missing job values as zero-dollar jobs. There
are no booked jobs today, and RYCO's typical job value is not configured.

## Decisions for Ryen

Record these once, then enter them in **Operations → RYCO → Call setup**:

- Exact legal business name.
- Normal business hours, including timezone and weekend/holiday handling.
- Coverage rule: which unanswered, busy, after-hours, or overflow calls should
  reach Relay and how long the published number should ring first.
- Booking URL to send callers, if different from the current link.
- Typical job value for reporting estimates.
- Approval or edits for the proposed automatic reply:

  > Hi, this is RYCO Property Maintenance — sorry we missed your call. Book or
  > reply here: {INTAKE_URL}. Reply STOP to opt out.

- Approval or edits for the voicemail greeting:

  > Thanks for calling RYCO Property Maintenance. Sorry we missed you. We will
  > text you shortly. Please leave a quick recorded message after the tone.

- Billing is decided: RYCO remains intentionally comped for the foreseeable
  future. Do not collect a card, charge a setup fee, create a subscription, or
  start a trial unless Sutton explicitly changes that policy later.

The current `comped` policy is authoritative and prevents a charge. The
underlying `standard` offer and `due` setup-fee fields describe what would apply
only if free access were explicitly ended; they are not current payment duties.
The January 26, 2027 free-access review date is an internal reminder, not an
expiration date, payment date, or authorization to change RYCO's policy.

## Work while Relay completes Twilio ISV approval

- Keep RYCO A2P at `not_started`. Do not create or invent account campaign
  evidence while Relay's ISV application is still with Twilio Customer Support.
- Track the ISV application as a Relay-owned platform prerequisite. Ryen does
  not need to resolve it and automatic texting must remain off.
- After ISV approval, create or attach RYCO's Messaging Service and campaign,
  enter both SIDs in Operations, and select **Sync status**. Only then should
  Relay show `in progress` with a last-sync time.
- Recover both transcript-only voicemail summaries. Each lead now offers
  **Generate summary** without retranscribing the recording; the scheduled
  recovery job can also process them.
- Place a new real missed call, leave a clear service request, and verify this
  chain: recording saved → transcript saved → grounded summary saved → visible
  in the correct RYCO lead.
- Send the owner-notification test only after confirming Ryen's destination
  address. Ryen must confirm receipt from his authenticated Setup page; provider
  acceptance alone is not confirmation.
- Give Ryen the [owner quick start](owner-quick-start.md) and walk through one
  lead from New → reply → Contacted → booked with a value.

## Post-approval test checklist

Use the [post-approval activation runbook](operations/a2p-post-approval-activation.md)
for the controlled sequence. Do not change RYCO's texting switch until Ryen can
review the final message and authorize it from his own signed-in account.

- [ ] Sync A2P from Twilio; Relay shows `approved` and a current sync time.
- [ ] Confirm the RYCO Relay number is SMS-capable and in the campaign's
      Messaging Service sender pool.
- [ ] Ryen enables automatic texting from his authenticated owner Settings page
      and checks the separate authorization statement; confirm Relay retained
      `texting.activation_approved` for his owner user.
- [ ] Place one real unanswered call to RYCO's published number.
- [ ] Confirm exactly one RYCO lead is created with the correct call time.
- [ ] Leave a clear voicemail; confirm playback, transcript, and grounded
      summary in the same lead.
- [ ] Confirm the missed-call SMS body matches Ryen's approved copy.
- [ ] Wait for Twilio's real `delivered` callback; do not count `sent` as
      delivered.
- [ ] Reply from the caller's phone and confirm the inbound message appears in
      the correct lead thread.
- [ ] Reply from Relay and confirm delivery to the caller.
- [ ] Run one controlled non-SMS-number test and retain Twilio error `30006`.
- [ ] Send the owner email test and have Ryen confirm receipt in Setup.
- [ ] Mark the test lead booked, enter a value, and confirm Reports updates.
- [ ] Run `npm run verify:account -- ryco-property-maintenance`.
- [ ] Run `npm run verify:launch -- ryco-property-maintenance`.
- [ ] Ask Ryen to approve go-live only after every prior item passes.
