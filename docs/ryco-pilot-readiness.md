# RYCO Pilot Readiness

Internal working record for the conversation with Ryen and the period while
Twilio reviews the messaging campaign.

## Baseline

Captured from production on **August 20, 2026 at 7:14 PM PT** with
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
off. Relay currently records A2P as `not_started`; there is no synchronized
Twilio carrier profile or last-sync timestamp. No owner notification has been
sent or confirmed, and the owner has not approved go-live.

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

- Commercial choice: keep the account intentionally comped, or convert it to
  the founding-pilot billing path with an audited setup-fee waiver, saved card,
  and delayed 30-day trial.

Until that decision is recorded, keep the current `comped` policy. It prevents
a charge even though the legacy offer and setup-fee fields still read
`standard` and `due`.

## Work before Twilio approval

- Enter the campaign and Messaging Service SIDs in Operations and select
  **Sync status**. Relay should then show `in progress`, the Twilio profile
  state, and the last Twilio sync time.
- Confirm the Relay number belongs to the correct Messaging Service sender
  pool. Do not enable automatic texting before authoritative approval.
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

- [ ] Sync A2P from Twilio; Relay shows `approved` and a current sync time.
- [ ] Confirm the RYCO Relay number is SMS-capable and in the campaign's
      Messaging Service sender pool.
- [ ] Enable automatic texting from the authenticated owner Settings page.
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

