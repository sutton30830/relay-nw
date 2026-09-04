# Known-contact handling — implementation specification

Status: **Steps 1–2 complete. Steps 3–8 not implemented.**

Local database prerequisite: **complete**, following the separately authorized setup on 2026-09-03. PostgreSQL 17.11 now runs in the repository's private socket-only cluster, with the checked-in schema loaded and real role/RLS/RPC/constraint checks passing. See [local database operations](../operations/local-test-database.md). The Step 2 contact migration and feature-specific SQL/RLS checks have also passed (see §14).

Inspected on 2026-09-03 America/Los_Angeles (2026-09-04 UTC). Repository: `/Users/suttonlowry/Documents/relay-nw copy`. Feature branch: `codex/known-contacts`, created from `codex/pwa-owner-alerts` at `0799c38a915d44e41014528bcf4d5b2ac2e0dd41`. This document describes intended changes, not deployed behavior.

## 1. Persistent instructions and scope

These are the user's accepted requirements for all eight steps:

- A known contact is deliberately imported or saved by the owner. Previous calls, existing lead names, and manual replies do not create contacts.
- New contacts are `unclassified` and suppress automatic missed-call SMS. Importing contacts never creates leads.
- Unclassified contacts and customers remain in the business inbox and Reports. Customers can explicitly become eligible for automatic texts again.
- Personal contacts always suppress automatic texts. Their existing and future calls are recoverable in Personal and excluded from business Reports and recaps. Preserve call, message, voicemail, and booking records.
- Retain missed-call owner notifications under existing account preferences. Contact suppression affects caller automation, not owner alerts.
- Manual texting uses the existing composer/reply endpoint, recipient opt-out checks, and account texting eligibility. It does not re-enable automation.
- Reclassification/removal changes the grouping of retained history. Removal restores ordinary eligibility for future calls only. Never replay skipped calls or rewrite past delivery outcomes.
- Match exact validated, normalized phone numbers within an account; never names or phone suffixes. A person's different numbers can be separate records.
- Reimports preserve existing classification, texting preferences, and owner-entered names. Contact membership is neither a Personal classification nor texting consent.

Working instructions:

- Read applicable repository instructions and inspect the branch/diff before each step. Continue on this feature branch and preserve unrelated work.
- Implement only the requested step and its necessary prerequisites. Resolve routine choices consistent with this document without reconfirming the specification.
- Reuse current authentication, tenant isolation, provider abstraction, UI, and tests. Update `supabase.sql` and a dedicated migration for database changes.
- Use local/test resources. Production deployment, production data changes, and real SMS/email/push delivery remain outside these prompts.
- Update this document with decisions, exact changes, verification evidence, and remaining work after every step. Distinguish implemented from verified, and mocked checks from real database/device checks.
- Complete and report one numbered step before proceeding to the next. Application implementation begins in Step 2.

No applicable `AGENTS.md` was found in the repository (including hidden-path search) or at the ancestor locations inspected. Unrelated starting changes were two modified documents (`docs/operations/backup-restore-drill.md`, `docs/pilot-certification-checklist.md`) and untracked board-meeting/Word files, `_to_delete/`, and the known-contact/provider-abstraction prompt documents. They were preserved; the starting tracked diff contained no application changes.

## 2. Product decisions

| Number's current classification | Automatic caller SMS | Business inbox / Reports | Personal view |
| --- | --- | --- | --- |
| No saved contact | Existing account/opt-out/cooldown rules | Included, subject to Trash | No |
| Unclassified | Suppressed | Included, subject to Trash | No |
| Customer | Suppressed by default; explicit `standard` policy enables normal eligibility | Included, subject to Trash | No |
| Personal | Always suppressed | Excluded | Included unless independently trashed |

`standard` means eligible under the ordinary SMS gates, never permission to bypass them. Only Customer contacts can have `standard`. Changing a Customer to Personal or unclassified atomically sets policy to `suppress`. Changing Personal back to Customer leaves suppression on until explicitly changed. Removing a contact removes only its preferences and metadata, leaving all retained lead/message data intact.

Contact removal returns non-trash retained calls to their normal business grouping; it does not restore independently trashed records. A reimport after deliberate removal creates a new unclassified, suppressed contact. No import, classification change, deletion, or undo sends a message.

Permissions follow existing account write roles: owners and admins manage contacts; viewers may read but cannot mutate. The existing account-wide texting activation switch remains owner-only and retains its activation requirements. Do not grant platform operators a new implicit account-contact mutation route.

### Names

Display precedence: nonblank explicitly stored `leads.name`, then contact `display_name`, then the existing unknown-caller/phone presentation. Keep stored lead names and computed contact display metadata separate. Do not copy imported names into `leads.name`: doing so would make name precedence and later removal irreversible. An owner who clears a lead name resumes contact-name fallback; an intentionally nameless contact requires clearing the contact name too.

Use the same precedence in cards, drawer, full conversation, and search. Existing `updateLead({name})` changes sibling lead names by phone; preserve that explicit edit behavior. Do not show a fallback name in the editable lead-name input as though it were a stored owner edit.

For owner email/SMS, use an available contact name with appropriate escaping/length bounds and a direct `/leads/{id}` link so Personal calls remain reachable. Preserve the prompt push alert's current phone-ending text and opt-in controls; do not delay or duplicate it to obtain a contact name. Name lookup failure must not prevent owner alerts.

## 3. Verified architecture and integration points

| Area | Current implementation | Required integration |
| --- | --- | --- |
| Voice ingress | `app/api/twilio/voice/route.ts` exports handlers from `lib/telephony/providers/twilio-webhooks.ts`. The adapter validates signatures and resolves tenant evidence. | Retain adapter/signature/account boundaries. |
| Call completion | `/api/twilio/voice-status` is canonical; `/api/twilio/dial-status` is a compatibility alias for the same handlers. | Both must inherit the same contact behavior. |
| Business call processing | `lib/telephony/webhook-services.ts::processInboundCall` invokes `handleMissedCall` in forwarding mode; `processCallCompletion` invokes it for no-answer/busy/failed/canceled outcomes. Direct answered calls do not invoke it. | Put caller policy in the common missed-call path. |
| Durable capture | `lib/supabase/leads.ts::createMissedCallLeadIfNew` invokes `create_missed_call_lead_and_mark_live`; account/call uniqueness suppresses duplicate processing. A legacy fallback inserts a lead without inferring go-live. | Contact availability must not gate lead/call capture or signed activation evidence. Preserve RPC contract and duplicate exits. |
| SMS boundary | `lib/missed-call.ts` uses `getTelephonyProvider().sendSms`; the implementation is `lib/telephony/providers/twilio.ts`. Action key is `automatic_missed_call_sms:{leadId}`. | Evaluate policy immediately before this caller-send boundary; do not bypass the provider abstraction. |
| Current eligibility order | Disabled account exits first. Cooldown currently runs before opt-out and short-circuits the opt-out lookup. | Change to disabled → opted out → contact suppression → cooldown. |
| Current failure handling | Pre-send lookup failures currently set lead status `failed`, even though no SMS was submitted. Accepted sends are protected from being falsely failed by later bookkeeping errors. | Separate new pre-send blocks from delivery failures; preserve accepted-send protections. |
| Manual reply | `app/api/leads/[id]/reply/route.ts` enforces write access, account `smsEnabled`, account-scoped non-trash lead lookup, opt-out, and an idempotency key/claim before sending. Callback metadata says `manual_reply`. | Reuse unchanged eligibility semantics; Personal is not Trash. Never change auto-SMS policy/status as a side effect of a reply. |
| Inbound SMS | `processInboundMessage` stores in `inbound_messages` and `messages`; handles STOP/START/HELP separately and forwards owner notifications by preferences. | Preserve keyword responses and owner alerts. START clears recipient opt-out only, never contact suppression. |
| Access | `lib/auth.ts::requireAccountUserJson` resolves selected membership; `requireWriteAccessJson` permits owner/admin and rejects viewer. `assertAccountId` guards service calls. | All contact queries require account scope from the server session; reject supplied cross-account IDs. |
| Database posture | `lib/supabase/client.ts` is server-only, uses the service role. SQL uses restrictive deny-client RLS and service-role-only RPC grants. | Mirror this posture; adding permissive authenticated-user RLS is inappropriate here. |
| Inbox | `lead_inbox_condensed` selects one current row per `(phone, live-versus-trash)`; `lead_inbox_counts` and `search_lead_inbox` aggregate/search before pagination. `app/leads/_utils.ts` and `use-leads-inbox.ts` mirror behavior for sample/optimistic state. | Add contact context before filtering/counting/pagination and update both server and client projections. |
| Conversations | `getLeadConversation` loads siblings and phone-based history; `getLeadByIdForAccount` is the lean reply lookup. | Enrich display reads, preserve lean send lookup and account boundary. |
| Reports page | `app/reports/page.tsx` uses `getLeadInboxCountsForAccount`, not historical recovery statistics. | Preserve its current-card metric definitions while excluding Personal. |
| Weekly recap | `app/api/digest/weekly/route.ts` uses `getAccountRecoveryStats`; `lib/email.ts` formats historical activity. Bookings use `booked_at`; other activity has its own timestamps. | Exclude Personal from every contributing query and expose intentional skips separately. |
| Reply data | Checked-in `inbound_messages` has **no `lead_id`**. `getReplyStats` tries that column, then falls back to raw reply count and treats it as unique lead count. Current inbound `messages` writes also omit a lead ID. | Filter by sender phone without requiring a lead link. Do not perpetuate raw-message-count-as-unique-leads. |
| Operations | `lib/supabase/monitoring.ts` examines raw calls, leads, and provider actions, including pending calls without attempts. `lib/provider-actions.ts` distinguishes expected suppression. | Keep Personal call-capture evidence; intentional skips are not incidents, lookup failures are operational issues. |
| Retry paths | Caller auto-text sending was found only in `handleMissedCall`; provider failure records can recommend manual retry, but no generic executable auto-SMS retry endpoint was found. Owner SMS and manual replies have separate claims. | Do not invent a new auto retry mechanism. Any future executable caller retry must reuse the contact gate. |
| Account lifecycle | `lib/supabase/retention.ts` has `ACCOUNT_EXPORT_TABLES`, deletion preview, and export. `lib/retention-core.ts` requires archived/closed state and provider cleanup before `delete_account_data`. | Add contacts to export/preview/deletion counts and deletion transaction; keep preferences out of ordinary age-based retention. |

`getLastRecoveredCallAt` and `getSignedCallVerificationAt` feed operational/onboarding proof. Personal calls still count as evidence that forwarding works. Do not apply business-report filtering to these helpers.

## 4. Data design

### New table: `public.account_known_contacts`

| Column | Contract |
| --- | --- |
| `id` | UUID primary key, generated server-side/database-side |
| `account_id` | Required account FK, `ON DELETE CASCADE` |
| `phone` | Required canonical E.164 text; unique with `account_id` |
| `display_name` | Nullable trimmed text, maximum 120 characters; empty becomes null |
| `classification` | Required checked text: `unclassified`, `customer`, `personal`; default `unclassified` |
| `auto_sms_policy` | Required checked text: `suppress`, `standard`; default `suppress` |
| `source` | Required checked text: `manual`, `lead`, `csv`, `vcard`, `phone_picker`; origin of initial creation |
| `version` | Positive bigint, default 1, maximum JavaScript safe integer (9,007,199,254,740,991), incremented atomically on explicit edits; JSON number used to reject stale changes |
| `created_at`, `updated_at` | Required database timestamps; created time immutable |

Database checks enforce canonical E.164 structure (`^\+[1-9][0-9]{7,14}$`), allowed values, and `auto_sms_policy = 'suppress' OR classification = 'customer'`. Format checks do not prove a number can receive SMS. Server validation must also validate parsed numbers; reachability stays the provider's concern.

Indexes: unique `(account_id, phone)` for matching/merge, and `(account_id, classification, id)` for scoped listing. Limit searches and paginate with a stable sort; no additional search infrastructure is needed for the initial pilot.

Enable RLS; revoke client access and apply the existing restrictive deny policy for `anon`/`authenticated`. Explicitly grant only necessary service-role operations. Any new SQL helpers/RPCs similarly revoke public/client execution and use a fixed search path. Test both the service-layer account filter and real database role access.

Keep `opt_outs` unchanged. Do not add Personal flags, copied contact names, or contact FK dependencies to historical leads/messages. Derive current contact metadata at read time using account and phone so imports/removals/reclassification affect all retained history without bulk rewriting it.

Paginate contact export to completion; the import limit can exceed a database API's default response limit. Include the exact contact count in deletion preview and the deletion transaction's returned counts. Ordinary account archival or operational retention must preserve these preferences until an explicit contact/account deletion.

### Phone matching

Add a narrowly scoped validated contact-number parser in `lib/contacts.ts` (or a focused module it imports). The current `lib/phone.ts::normalizePhoneNumber` returns arbitrary unrecognized text and accepts overly long `+` inputs; it is insufficient as an import validator.

- Accept explicit international numbers; offer an explicit country selection for national-format imports, defaulting to the product's existing US context. Validate after parsing and format as E.164.
- Reject ambiguous/invalid numbers, withheld callers, extensions without a clearly separable base number, and arbitrary text. For the first version, require the owner to correct extension-bearing entries rather than stripping digits and guessing.
- Apply the same validation to manual saves, lead saves, CSV, vCard, and picker entries. Do not trust client normalization.
- For existing stored call/message numbers, introduce a shared SQL `known_contact_phone_key(text)` that only normalizes the existing supported forms: canonical international `+` numbers, punctuation-only variants, and validly structured US 10-digit/11-digit-with-leading-1 forms. Return null for letters, extension syntax, other ambiguous national formats, or invalid structure. Require parity fixtures with the TypeScript canonicalization. Matches still require exact equality to a validated contact's E.164 number.
- This helper allows retained common legacy formats to match without rewriting history or comparing suffixes. It must not reinterpret arbitrary foreign local numbers. Preview normalization conflicts before import; exceptional legacy data requires an explicit local/test preflight and later account correction, not a global speculative backfill.

### Merge and concurrency

New-contact creation/import uses an atomic insert with conflict handling on `(account_id, phone)`. For an existing record, return it unchanged: **imports do not update any existing field, including an empty name**. This deliberately simple merge rule preserves owner-cleared names without adding name-provenance columns. Owners can explicitly edit an existing name in Settings.

Within one incoming batch, collapse duplicate canonical numbers. Preview conflicting names; retain the first selected nonblank name unless the owner resolves the conflict. The merge service rejects duplicate numbers with conflicting classifications; the preview must resolve these before committing. Multi-number contacts produce separate entries. Batch classification defaults to unclassified; only explicit selection creates Personal contacts. Imports cannot set `standard`.

Explicit PATCH/DELETE operations require the current `version` and reject stale state with 409. Quick lead actions must atomically find/create/update the contact and cannot overwrite an existing name inadvertently. Existing contacts require both `contactId` and `version`; new-contact actions omit both (or send both null). Checking identity prevents an old action from changing a deleted-and-recreated contact whose version has restarted at 1. Successful reclassification returns fresh contact state for invalidation. A contact deleted and then deliberately imported again is new; an interrupted retry must preserve any records that currently exist and report outcomes accurately.

## 5. Service and API contracts

New server module: `lib/supabase/contacts.ts`; export public types/services through `lib/supabase/index.ts` and the existing facade. Pure parsing/policy helpers belong in `lib/contacts.ts` so tests do not need a live provider.

Services: `getKnownContactByPhone(accountId, phone)`, batched contact lookup, `listKnownContacts`, `createKnownContact`, `updateKnownContact`, `deleteKnownContact`, `setLeadContactPreference`, and `mergeKnownContacts`. All require `accountId`; all ID-based mutations include it in SQL predicates. Avoid one contact query per lead card.

| Route | Contract |
| --- | --- |
| `GET /api/contacts?q=&classification=&limit=&offset=` | Selected account membership required. Default limit 50, maximum 100; query max 120 characters. Return `{ contacts, total, limit, offset }`. |
| `POST /api/contacts` | Write guard. `{ phone, displayName?, classification? }`; default suppression. Return 201 created or 200 existing, with `{ contact, created }`. Existing records are not silently overwritten. |
| `PATCH /api/contacts/[id]` | Write guard. `{ version, displayName?, classification?, autoSmsPolicy? }`; apply explicit edits atomically, enforce policy constraints, return `{ contact }`. Phone/account/source/id are not mutable. |
| `DELETE /api/contacts/[id]` | Write guard and supplied current version; remove only the contact. Missing/foreign ID is 404, stale version 409. Return `{ removed: true }`. Repeating removal must not affect history or another account. |
| `POST /api/leads/[id]/contact` | Write guard; derive phone from the account-scoped lead. Body `{ action: "suppress_auto_sms" | "mark_personal", contactId?, version? }`; existing contacts require both current ID and version. Omit both for expected absence; a create/edit race returns 409. Suppressing preserves classification/name; marking Personal sets suppression atomically. |
| `POST /api/contacts/import/preview` | Step 6. Authenticated write guard; CSV/vCard file plus country/mapping choice. Return candidate rows, validation issues, duplicates/conflicts, and proposed actions. Never persist raw file or create contacts here. |
| `POST /api/contacts/import` | Step 6. Write guard; maximum 250 reviewed entries per transaction, supported source, and only permitted import fields. Revalidate everything. Return per-row outcomes and added/existing/rejected totals. Picker reuses this route. |

Use existing same-origin session conventions and private/no-store responses. Return validation errors without raw files or contact lists in logs. Use 400 for invalid input, 401/403 from auth, 404 for absent scoped resources, 409 for edit conflicts, 413 for size limits, and 503 for unavailable required storage. Failed writes must not claim protection is saved. Invalidate contact/inbox/Reports reads after successful writes; a stale client response must not overwrite a newer version.

## 6. Automatic SMS decision and failures

1. Keep signature validation, tenant resolution, durable call/lead capture, and duplicate exits in their existing order. Start/retain the independent owner push path after capture.
2. Attempt contact metadata resolution after capture even if caller texting is disabled. A metadata failure is not evidence that the caller is unknown.
3. Evaluate terminal reasons in order: `skipped_disabled`, `skipped_opt_out`, `skipped_known_contact`, `skipped_recent`, otherwise send. An enabled Customer has no contact-based terminal reason. A higher-priority known suppression reason remains the terminal status even if unrelated metadata lookup fails.
4. Preserve deterministic cooldown winner selection based on lead creation time/ID. A skipped contact is not a sent message and must not create a cooldown send record.
5. Perform a fresh, uncached contact-policy lookup at the final eligibility gate after other necessary awaits and immediately before initiating provider submission. Recheck recipient opt-out there as needed so no new contact path bypasses existing protection. No owner-notification await should widen the gap between this gate and submission.
6. Record provider action and actual submission accurately using the existing action key/callback metadata. Preserve the existing separation between provider acceptance and subsequent message/status bookkeeping failure. No fake outbound message row is created for suppression.

Reserve any required processing evidence before the final read with `countAttempt: false`; do not insert another awaited bookkeeping/notification operation between that read and initiating `sendSms`. Record an actual provider attempt only when submission has occurred, using the outcome/reconciliation paths without double-counting callbacks. A processing reservation that the final contact check suppresses is not a send attempt.

Add lead SMS statuses `skipped_known_contact` and `blocked_pre_send` in SQL and `SmsStatus`.

| Outcome | Lead status / owner wording | Provider-action evidence |
| --- | --- | --- |
| Saved policy suppresses | `skipped_known_contact`; “Not auto-texted: known contact” | Existing auto-SMS action key; provider `relay`, status `known_contact`, internal status `suppressed`, expected suppression true, countAttempt false, retry `never` |
| Required eligibility lookup fails while otherwise eligible | `blocked_pre_send`; “Not texted: texting checks unavailable” | Internal status `failed`, status `pre_send_check_failed`, expected suppression false, no provider message ID/submit attempt, retry `never`; advise checking Operations and explicitly replying/calling |
| Disabled/opted-out already established, but contact metadata fails | Preserve `skipped_disabled`/`skipped_opt_out`; metadata may be unavailable | Separate metadata operational issue, not an SMS delivery failure |

Use `blocked_pre_send` for the new common pre-send failure path, including its opt-out/cooldown failures, so a failure to decide is not mislabeled as a carrier delivery failure. Do not backfill historical `failed` values speculatively. Mark these new blocks as needing attention, but exclude them from actual delivery-failure metrics. If even status/evidence persistence fails, log the operational failure and preserve call capture and owner-alert attempts; never fall through to sending.

All new terminal branches attempt configured owner email/SMS and await the existing push completion. Use isolated error handling so failure in one alert does not prevent another or fail the voice response. Owner SMS still respects account `smsEnabled`, configured sender, preferences, and self-call suppression. The user-facing explanation must never claim “auto-text FAILED” for an intentional skip.

### In-flight boundary

The last successful eligibility read immediately before initiating provider submission is the decision boundary. Contact edits committed before that read must affect the send. Edits committed after it can race with an already initiated request; the system cannot atomically transact a contact edit with an external provider send or recall an accepted SMS. State this honestly in Settings/help and test both sides using a controlled provider barrier.

Do not add a queue, cancellation promise, or automatic replay as part of this feature. Replayed webhooks keep the existing duplicate exit. Existing provider-ID/callback reconciliation never resubmits SMS, and manual replies continue through their separate endpoint. START, manual reply, changing a name, restoring Trash, or changing classification does not automatically enable contact policy.

## 7. Inbox, history, and reporting

### Shared query projection

Build an account-filtered SQL projection joining leads to contacts on account and `known_contact_phone_key(leads.phone) = contacts.phone`. Expose raw `name` plus computed `display_name`, contact ID/version/name/classification/policy, and `is_personal`. No contact row means `is_personal = false`; failed lookup/query means unavailable data, not a fabricated non-personal result.

Keep base capture data and `lead_inbox_condensed`'s original row cardinality. Apply Personal predicates before counts, search, and pagination, not after fetching a page. Use versioned service-role-only RPCs `search_lead_inbox_v2` and `lead_inbox_counts_v2` to add projection/count columns without dropping live RPC return types during deployment. These may reuse shared SQL helpers; keep legacy RPCs available until rollout is verified. App code must use v2 after migration and must not silently fall back to unfiltered legacy queries on missing v2.

- Business filters (`all`, `new`, `contacted`, `booked`, `dead`): `deleted_at IS NULL AND NOT is_personal`.
- Personal filter: `deleted_at IS NULL AND is_personal`; all existing lead statuses may appear.
- Trash filter: `deleted_at IS NOT NULL`, regardless of classification. Preserve Personal badges and restore to the current classification's view.
- Retain the existing one-card-per-phone/live-or-trash grouping and account-wide raw call-count badge. This feature does not merge existing phone-string groups as an unrelated deduplication change; canonical variants nevertheless get the same contact policy/classification.
- Return separate `personal` and `smsBlocked` counts. Existing business counters, `smsIssues` (actual failures), and booked values exclude Personal. Known-contact skips do not enter either issue counter. Personal view may display an operational warning without contaminating business counts.
- Update `app/leads/page.tsx` filter whitelist, `_constants.ts`, `_utils.ts`, types, hook optimistic deltas, full conversation, and server-to-client metadata. Invalidate all affected history after contact changes, including rows beyond the loaded page; re-fetch authoritative global counts.
- A missing contact-aware projection yields a recoverable read/metrics error. Do not display fake zero totals or leak Personal calls via a compatibility fallback. Raw voice capture and operational monitoring remain available.

### Reporting definitions

Reports and the inbox use current condensed non-trash business cards, including their current booking/value fields. Weekly recap uses historical non-trash business lead events: missed calls/text outcomes by `created_at`, bookings/value by `booked_at`, replies by message `created_at`. Preserve these deliberately different units. “Agree” means using the same eligibility rules and correct labels, not forcing current-card counts to equal weekly call totals.

Use database-side aggregates (or fully paginated equivalent) rather than loading a capped contact exclusion list or filtering the existing capped 2,000/5,000-row arrays. Introduce `account_business_recovery_stats(p_account, p_since, p_until)` and `account_business_response_stats(...)` service-only RPCs with the same time-window semantics and shared contact predicate. `lib/supabase/reports.ts` remains the typed facade. These are Step 4 changes, not new analytics pages.

- **Revenue/bookings:** filter the source lead by account, non-trash, and non-Personal before sum/count; preserve missing-value handling and the existing booking attribution rule. Classification changes recalculate retained history but never change `booked_at`, `job_value_cents`, status, or messages. Previously sent recaps are not edited or resent.
- **Replies:** `inbound_messages` is the single counting source, so mirrored `messages` rows are not counted twice. Exclude any sender whose canonical number is currently Personal, even with no associated lead. If a verified linked inbound `messages` row exists for the same account/provider message ID, also exclude a linked Personal or trashed lead. Unlinked replies from a sender with only trashed matching leads are excluded; senders with a live business lead or no historical lead remain eligible business replies. Do not infer Personal from body/name or invent a lead link.
- **Unique reply leads:** derive only from actual same-account inbound message-to-lead links if present. Return 0 verified links and an `unlinkedReplyCount` when links are absent, rather than treating raw replies as unique leads. The current UI/recap does not display `uniqueReplyLeads`; retain it as accurately defined internal data and update its existing source-contract test. No `inbound_messages.lead_id` migration is needed.
- **Response time:** retain first outbound timestamp per eligible missed-call lead, including intentional manual follow-up. Suppression alone contributes no timestamp. Do not insert fictional outbound messages or change the existing delivery-status interpretation incidentally.
- **Text outcomes:** add `knownContactSkipped` and `preSendBlocked` alongside the existing historical sent/failed counts. Keep delivery failures distinct. Show a compact intentional-skip explanation/count on the relevant business surface and recap; do not add a broad analytics grid. Blocked pre-send checks get a separate attention label.
- **Personal-only activity:** cannot trigger a business recap. An unclassified/customer missed call still counts as activity when auto-SMS was intentionally skipped. Keep operational call-capture, first-call verification, and raw health queries inclusive of Personal.

## 8. Import and user interface contracts

Step 5 adds Contacts in Settings and distinct lead actions: **Turn off automatic texts** (retain business classification) and **Mark as personal** (set Personal and suppress). The Personal view supports reclassification. Undo uses version-aware explicit edits and never restores stale settings over a concurrent change. Contact removal preserves independent Trash state.

“Text them anyway” opens the existing composer with the account's current approved missed-call/booking message for review. Obtain any server-generated template through the existing server/client boundary; do not expose provider credentials or import server-only code into the client. Send only after the owner presses Send, using the existing idempotent reply route. Do not promise a booking link when the account has none configured.

Step 6 import sequence: Choose file → Preview → Review → Import → Result. Support documented Google Contacts CSV and Apple/iCloud vCard forms, multiple numbers, CSV quoting/multiline values, and vCard folding/escaping. Offer column mapping and country selection for ambiguity. Verify the chosen parser's current documentation during implementation; no dependency is selected in Step 1.

Limits: raw file 5 MiB, at most 10,000 candidate phone entries per preview, commits of at most 250 entries per database transaction. Reject oversize inputs before unbounded parsing. Preview lists invalid rows, duplicate numbers, and conflicting names. New rows default unclassified/suppressed; explicitly selected rows may be Personal. Commit revalidates and rechecks existing contacts, so a stale preview cannot override current owner decisions.

On a failed commit batch, roll back that batch; retain completed batches and show their actual outcomes. Retry missing batches safely using unique-key inserts. Count each canonical entry once in the UI, maintain the completed-batch ledger in the current import session, and distinguish a replay's “already exists” outcome from a fresh addition. Reloading/reimporting may report entries as existing and must not claim they were newly added. No durable address-book file or raw preview payload is retained; store only allowed contact fields. No addresses, emails, birthdays, photos, notes, or contact contents in diagnostics.

Step 7 adds a feature-detected contact picker requesting only name/tel, from an explicit gesture in a supported secure context. Reuse Step 6 preview/commit. Cancellation and unsupported/exposed-but-failing APIs fall back to manual/file import without mutation. Do not advertise ordinary iPhone Safari support or background synchronization based solely on API presence; verify current documentation and real-device evidence in that step. Android Chrome and iPhone Safari device checks remain separate from mocked browser tests.

## 9. File-level checklist for Steps 2–8

| Step | Files / responsibilities | Completion gate |
| --- | --- | --- |
| **2 — Data/API** | New `lib/contacts.ts`, `lib/supabase/contacts.ts`, `app/api/contacts/route.ts`, `app/api/contacts/[id]/route.ts`, `app/api/leads/[id]/contact/route.ts`; `lib/supabase/types.ts`, `index.ts`; `supabase.sql`; new dedicated migration under `docs/migrations/`; `lib/supabase/retention.ts` and SQL deletion counts. | Behavioral CRUD/merge/version/tenant/role tests; real local/test SQL constraint/RLS/transaction/export/deletion checks. |
| **3 — SMS** | `lib/missed-call.ts`, contact helpers, `lib/supabase/messages.ts`/types, SQL status constraints, `lib/email.ts`, status helpers in `app/leads/_utils.ts`/lead card, provider-action and monitoring adapters as required. Preserve `webhook-services.ts`, Twilio adapter contracts, callback/manual-reply separation. | Unknown/personal/customer/opt-out/disabled/error/duplicate/concurrent call tests with an instrumented provider; no suppressed caller send; owner alerts preserved. |
| **4 — Queries/Reports** | SQL projection and v2 inbox/report RPCs; `lib/supabase/leads.ts`, `reports.ts`, types; `app/leads/page.tsx`, `_types.ts`, `_constants.ts`, `_utils.ts`, `_hooks/use-leads-inbox.ts`; `app/reports/page.tsx`, `lib/report-hero.ts` as needed, `lib/email.ts`, `app/api/digest/weekly/route.ts`. | Mixed-account fixtures and SQL integration prove filtering before pagination/aggregation; no personal reply/revenue leakage or false failure counts; operational proof preserved. |
| **5 — UI** | `app/settings/page.tsx` plus contact component(s); lead card/drawer, `app/leads/_api.ts`, conversation view, controls/hook, scoped styles in `app/globals.css`. | Desktop/mobile visual review and meaningful interactions covering errors, permissions, undo, saved names, Personal, refresh/navigation, and manual reply. |
| **6 — Imports** | New parser/import modules and preview/commit routes; Settings import component(s); shared merge service; parser dependency/lockfile only if justified. | Representative CSV/vCard fixtures, limits, multi-number, conflicts, malformed input, reimport, partial failure/retry, tenant isolation, and visible preview/results. |
| **7 — Picker** | Contact import UI adapter and browser types/feature detection only; shared existing importer. | Unsupported/canceled/rejected/multi-number tests; separately reported physical Android/iPhone results. |
| **8 — Review/pilot** | Review full feature diff; fix feature defects; update this spec and create `docs/operations/known-contacts-pilot.md`. | Required lint/typecheck/build/regressions plus real SQL and device evidence; honest release-readiness verdict and rollout/rollback procedure. |

Suggested new tests: `tests/known-contacts.test.mjs`, `known-contact-routes.test.mjs`, `known-contact-sms.test.mjs`, `known-contact-reporting.test.mjs`, and `contact-import.test.mjs`, using the existing VM/module mocks and two-business fixture. Extend existing fixtures when production imports gain required dependencies; do not add production fallbacks merely to satisfy incomplete mocks. Add a local/test SQL verification script for the new schema and v2 RPCs; it must refuse a non-test target.

## 10. Required behavioral validation

| Scenario | Expected evidence |
| --- | --- |
| Unknown number | Ordinary gates and provider action preserved; no implicit contact created. |
| Imported unclassified / Customer | No auto text by default; business visibility and owner alerts retained. |
| Personal existing/future calls | No caller auto text; non-trash history visible in Personal; bookings/messages/voicemail untouched. |
| Explicit Customer `standard` | Normal eligibility; cannot override account disabled, recipient opt-out, or cooldown. |
| Recipient START / manual reply | Does not clear contact suppression. Opted-out manual replies remain rejected. |
| Account disabled + known contact | Classification/name still resolved; reason remains disabled; permitted owner channels continue. |
| Known and opted out, or known and recent | Reason follows precedence: opted out before known; known before recent. |
| Contact lookup unavailable | No caller send; actionable block or already-established higher-priority suppression; capture and owner-alert attempts survive. |
| Save during a call | A commit before the final read suppresses; a commit after submission begins does not claim cancellation. |
| Duplicate/concurrent calls | Same call creates/sends at most once; preserve deterministic cooldown winner for distinct simultaneous calls. |
| Reimport/concurrent manual edits | Unique rows, existing fields unchanged, stale explicit edits rejected; no SMS/leads generated. |
| Contact removal/reclassification | All retained canonical matches regroup; independent Trash stays; no backlog send/history rewrite. |
| Same number in accounts A and B | Different policy/name/classification allowed; no cross-tenant read, mutation, query result, or notification context. |
| Linked/unlinked Personal inbound SMS | Neither counts toward business replies/recap; mirrored message rows do not double count. |
| Large mixed dataset | Filtering/counts remain correct beyond inbox and old report limits; search includes effective display names. |
| Export/deletion/retention | Contact data included in scoped export/preview/deletion; age-based operational cleanup cannot silently re-enable automation. |

Existing query/metric source-contract tests will need intentional updates where they assert the old cooldown-before-opt-out behavior, unfiltered fallback, or raw replies as unique lead counts. Preserve their underlying guarantees and add behavioral coverage for replacements; do not simply weaken assertions to make changed code pass.

## 11. Migration and deployment order

No migrations were created or executed in Step 1.

1. **Step 2 local/test foundation:** create the contact table, constraints, helper/merge functions, role restrictions, and lifecycle inclusion in a dedicated dated migration; mirror final definitions in `supabase.sql`. Start with zero contacts; never seed from leads or opt-outs. Verify fresh install and upgrade from the current schema.
2. **Step 3 local/test status expansion:** add `skipped_known_contact` and `blocked_pre_send` before code writes them. Preserve existing status values and RPC signatures.
3. **Step 4 local/test projections:** add contact-aware versioned RPCs and historical aggregate functions before switching application reads. Verify the old app remains usable while no contact management has been exposed. Freeze committed migrations; use new additive migrations for later steps instead of rewriting applied history.
4. **Steps 5–7:** complete UI/import integration on the feature branch. Do not expose contact saves/imports in an environment where the caller suppression gate is absent. A rollout flag, if needed, controls contact-management exposure, not whether already-saved suppression is respected.
5. **Step 8 preparation:** record SQL/RLS, regression, browser, and device evidence and prepare the exact pilot procedure. Required deployment gates must not be labeled passed from mocked tests alone.
6. **Later separately authorized rollout:** apply verified additive migrations first, deploy the complete app second, verify schema/app compatibility and owner manual-add before importing Ryen's selected contacts. Use explicitly designated test numbers for caller/owner-delivery checks and compare business/Personal views and recap data.
7. **Rollback:** retain contacts and expanded schema. Keep a suppression-capable app version, or disable caller auto-SMS before returning to an older app that lacks the gate, while preserving call capture. Do not drop contact tables/statuses or switch off enforcement to restore service. Never automatically retry previously skipped/blocked calls.

## 12. Baseline verification recorded in Step 1

Environment: Node `v25.5.0`; branch/base recorded above. Verification started at `2026-09-04T01:09:45Z`. Tests used existing local VM mocks/fixtures; no production database or messaging service was used.

| Check | Result | Scope/limitation |
| --- | --- | --- |
| Selected existing regression suite, 26 files | **253 passed, 0 failed, 0 skipped**; test runner duration 3,980 ms | Existing behavior only; includes functional module mocks and source-contract assertions. No known-contact implementation exists yet. |
| `npm run typecheck` | **Passed**, exit 0 | `tsc --noEmit --incremental false`; no application build or server execution. |
| Repository/ancestor instructions and starting diff | Inspected; feature branch created; unrelated work preserved | No applicable AGENTS found. |
| Live SQL/RLS/migration validation | **Not run** | No feature migration yet; `psql`, `supabase`, and `docker` were not found on PATH, and no local Supabase/compose setup was found in the inspected repository files. Provision/identify an authorized local/test database in Step 2. |
| Lint, production build, complete test suite, browser/device tests | **Not run in Step 1** | Not needed to verify a specification-only change; still required where listed in later gates. |

Exact test command (run from the repository root):

```sh
node --test \
  tests/sms-opt-lifecycle.test.mjs \
  tests/a2p-gating.test.mjs \
  tests/audit-fixes.test.mjs \
  tests/dial-status-fallback.test.mjs \
  tests/voice-webhook-response.test.mjs \
  tests/twilio-webhook-signature.test.mjs \
  tests/technical-setup-state.test.mjs \
  tests/telephony-provider-contract.test.mjs \
  tests/provider-failure-recovery.test.mjs \
  tests/pipeline-failure-handling.test.mjs \
  tests/notification-preferences.test.mjs \
  tests/alert-backstop.test.mjs \
  tests/web-push.test.mjs \
  tests/account-isolation.test.mjs \
  tests/behavioral-isolation.test.mjs \
  tests/multi-business-adversarial.test.mjs \
  tests/role-enforcement.test.mjs \
  tests/multi-account-auth.test.mjs \
  tests/lead-ordering.test.mjs \
  tests/reports-contract.test.mjs \
  tests/report-metrics.test.mjs \
  tests/report-hero.test.mjs \
  tests/monitoring-health.test.mjs \
  tests/scheduled-monitoring.test.mjs \
  tests/retention-controls.test.mjs \
  tests/tenant-contract.test.mjs
npm run typecheck
```

Transient detailed logs: `/private/tmp/relay-known-contacts-step1-tests.log` and `/private/tmp/relay-known-contacts-step1-typecheck.log`. These may expire; the command, baseline revision, totals, and limitations above are the durable evidence. No unrelated failures were encountered in these checks and no application fixes were made.

## 13. Compatibility findings and progress ledger

These are implementation requirements, not blockers requiring a new product decision:

1. Existing cooldown precedence differs from the requested order; Step 3 must change it without weakening duplicate control.
2. Existing name/Trash fields cannot represent contact suppression and Personal grouping; use the separate contact table and computed context.
3. Report-page counts and weekly historical totals intentionally differ; unify eligibility, not units.
4. Inbound reply links are absent in the checked-in schema; sender matching is mandatory and unique linked-lead data must not be invented.
5. Legacy unfiltered inbox/report fallbacks are incompatible with guaranteed Personal exclusion; contact-aware reads must fail visibly when their required schema is unavailable.
6. Pre-send failures currently resemble delivery failures; the explicit blocked status is needed for accurate outcomes.
7. Externally accepted SMS cannot be recalled; the final-read boundary is the supported guarantee.
8. Step 1 initially lacked a local/test database. This prerequisite is now resolved by the separately authorized PostgreSQL setup described above. Use `npm run db:local -- start` and `npm run db:local -- verify`; the contact migration and additional SQL/RLS tests are now verified in Step 2.

| Step | State | Evidence / next action |
| --- | --- | --- |
| 1 — Architecture/specification | Complete | Current paths inspected, product/technical contracts recorded, 253 baseline tests and typecheck passed. |
| Local database prerequisite | Complete | PostgreSQL 17.11; unchanged base schema loaded; actual client-role RLS, service RPC, idempotency, check constraint, and tenant FK verified. |
| 2 — Data/API | Complete | Schema/migration, scoped services/APIs, export/deletion, 12 feature tests and 18 real database checks passed; full suite 627/627, typecheck and lint passed. |
| 3 — SMS suppression | Not started | Implement gate/status/owner-alert behavior after Step 2. |
| 4 — Inbox/Reports | Not started | Implement shared classification projections and metric rules. |
| 5 — UI | Not started | Build contact and Personal controls against verified APIs. |
| 6 — CSV/vCard import | Not started | Build preview/merge and validate representative exports. |
| 7 — Phone picker | Not started | Add supported-browser adapter and record device evidence. |
| 8 — Review/pilot preparation | Not started | Complete release gates and write pilot runbook. |

Next numbered step when requested: **Step 3 — SMS suppression**. Step 2 has not connected stored preferences to caller automation or business/Personal grouping. No production resources or real messages were used.


## 14. Step 2 implementation and verification

Completed locally on 2026-09-03 America/Los_Angeles (2026-09-04 UTC), on the same `codex/known-contacts` branch. Production deployment is not part of this completion. Do not expose contact management in a deployed environment until the later suppression gate is present.

### Implemented files and contracts

- `docs/migrations/2026-09-03-known-contacts.sql` and identical final definitions in `supabase.sql`: table, unique/account/classification indexes, checks, restrictive RLS, revoked client privileges, service-only functions, immutable-identity/version trigger, and contact counts/deletion in `delete_account_data`. No pre-existing lead is converted to a contact and no retained history is rewritten. `opt_outs` and operational retention are unchanged.
- `lib/contacts.ts`: focused validation using pinned `libphonenumber-js@1.13.12` with `/max` metadata, default US national parsing and explicit supported-country selection for future imports. Reject extensions, arbitrary text, invalid numbering plans, malformed identifiers, unsafe/nonpositive versions, and control characters/overlong names. Historical canonicalization is deliberately narrower (ASCII whitespace/punctuation only); SQL/TypeScript parity fixtures cover it. This does not replace the unrelated existing phone helper.
- `lib/supabase/contacts.ts`, `types.ts`, `index.ts`: scoped lookup (batched by 250 distinct canonical keys), list/search, manual create, transactional merge, versioned PATCH/DELETE, and lead preference actions. Lookups are uncached and storage failures do not become fabricated success; placeholder Supabase configuration returns unavailable rather than claiming a preference was saved.
- `app/api/contacts/route.ts`, `app/api/contacts/[id]/route.ts`, `app/api/leads/[id]/contact/route.ts`, `lib/contact-api.ts`: account membership reads; owner/admin writes through existing guards; session-derived account only; strict field allowlists; streamed 16 KiB body cap; private/no-store responses; successful mutations invalidate Settings, Leads layouts/conversations, and Reports. Validation/not-found/conflict/storage status codes follow §5. Invalidation failure is logged without contact contents and does not misreport a committed mutation as failed.
- `lib/supabase/retention.ts`: contacts included in exact deletion preview counts and export. Contact export walks stable ID pages of up to 500 until an empty page, including if the HTTP API imposes a lower cap; it throws on query failure instead of returning a truncated success. Other export tables retain their previous behavior; this is not an unrelated full-export refactor. Export format remains version 1 with an additional table key.
- `tests/known-contacts.test.mjs`, `tests/helpers/contacts.mjs`: pure validation, scoped service contracts, authenticated route behavior, input/error handling, and a 1,203-contact paginated export plus exact preview count.
- `tests/integration/known-contacts-db.test.mjs`, `npm run test:contacts:db`: opt-in real PostgreSQL tests using dev dependency `pg`. The suite connects only to the owned socket cluster, verifies its actual identity/TCP state, creates fresh randomly named test databases, and drops only those it created. It never loads environment files or accepts a connection URL.

Concrete service signatures for later steps:

```ts
getKnownContactByPhone(accountId, phone) // Promise<KnownContact | null>
getKnownContactsByPhones(accountId, phones) // Promise<Map<canonicalPhone, KnownContact>>
listKnownContacts(accountId, { q?, classification?, limit?, offset? })
createKnownContact(accountId, { phone, displayName?, classification? })
mergeKnownContacts(accountId, entries, { source, country? })
updateKnownContact(accountId, id, { version, displayName?, classification?, autoSmsPolicy? })
deleteKnownContact(accountId, id, version)
setLeadContactPreference(accountId, leadId, { action, contactId?, version? })
```

`KnownContact` uses database snake_case fields (including `account_id`, `display_name`, `auto_sms_policy`, timestamps), while request fields use the camelCase contract above. Create returns `{ contact, created }`; merge returns one such result per canonical number in first-occurrence order. Merge validates the whole batch before submitting it; 1–250 inputs per transaction, first nonblank duplicate name wins, conflicting duplicate classifications reject the batch. Existing rows are returned byte-for-byte unchanged, including null names and prior timestamps/version/source/policy. New rows always suppress; only an explicit PATCH can enable a Customer.

All contact writes take a transaction-scoped account preference lock and a shared key lock on the account row. This serializes contact create/edit/delete races and orders them against account deletion; operations in unrelated accounts can proceed independently (a rare advisory-hash collision only causes extra waiting). The update trigger increments version and sets `updated_at` from the database clock; ID/account/phone/source/created time are immutable. A batch failure rolls back its writes. Concurrent imports report exactly one creation. Explicit stale edits/deletes return 409.

A lead action validates the scoped lead's phone in the service and checks that same phone against the locked lead again in SQL. Its initial name comes from that lead only when creating the contact; existing contact names are never overwritten. An expected-absent action races safely with import, and both contact ID and version protect expected-existing actions against deletion/recreation. Suppression retains classification; Personal forces suppression. A malformed ID/version pair is 400; stale identity/existence/version is 409; a foreign/missing lead is 404.

Database functions (all restricted to service role, fixed `public` search path): `known_contact_phone_key(text)`, `guard_known_contact_update()`, `lock_known_contact_account(uuid)`, `merge_known_contacts(uuid,jsonb)`, `update_known_contact(uuid,uuid,bigint,jsonb)`, `delete_known_contact(uuid,uuid,bigint)`, `set_lead_contact_preference(uuid,uuid,text,text,bigint,uuid)`, and `list_known_contacts(uuid,text,text,integer,integer)`. New functions run with invoker privileges; the existing deletion function retains its existing definer privileges and guards. List returns a literal case-insensitive name/canonical-phone substring search, ID-ordered page and total from one SQL snapshot; default 50/max 100, maximum 120-character query.

### Verification evidence

| Check | Result | Coverage / limits |
| --- | --- | --- |
| Dedicated migration against existing local database | Passed | Applied to the previously loaded pre-feature schema; reapplied after final function changes. Local only. |
| `npm run test:contacts:db` | 18 passed, 0 failed/skipped | Both fresh `supabase.sql` and upgrade from baseline `0799c38a915d44e41014528bcf4d5b2ac2e0dd41`, including repeat migration. Two real client sessions exercise concurrent imports/edits. |
| Actual database security | Passed within SQL suite | `anon` and `authenticated` denied table/RPC access. With table privileges and a permissive policy temporarily granted, restrictive RLS still prevents reads/updates/deletes/inserts. Service role is a nonsuperuser with BYPASSRLS; tenant predicates and foreign-ID mutations tested separately. |
| Actual database data integrity | Passed within SQL suite | Defaults, unique keys/FK/checks, stale versions, Personal policy, immutable identity, full-batch rollback, conservative reimport, deleted/recreated contact identity, retained calls/messages/voicemail/booking/delivery/opt-out data, exact account deletion counts and other-account preservation. |
| `node --test tests/known-contacts.test.mjs` | 12 passed, 0 failed/skipped | Phone validation, scoped services, all route guards, mass assignment/body limits, error status, paginated export. Auth/HTTP transport boundaries use existing VM mock patterns. |
| `npm test` | 627 passed, 0 failed/skipped | Complete repository suite, including 12 new tests; existing telephony, authentication, tenant, Reports, retention, and provider regressions passed. |
| `npm run typecheck` | Passed | Final source changes checked. |
| `npm run lint` | Passed | Full configured ESLint scope, zero warnings. |
| `git diff --check` | Passed | Tracked diff whitespace check. |
| Production build, browser/device checks, hosted Supabase HTTP integration | Not run in Step 2 | No UI or telephony behavior was implemented here. Local engine has no PostgREST/Auth/Storage HTTP servers. These results do not certify deployment, real delivery, or a browser flow. |

Repeatable commands and test files above are the durable evidence. Detailed transient logs: `/private/tmp/relay-known-contacts-step2-tests.log` and `/private/tmp/relay-known-contacts-step2-sql.log`. No unrelated failures were repaired. No concrete Step 2 blocker remains. Steps 3–8 remain outstanding; automatic SMS eligibility and business/Personal history grouping are unchanged until their respective steps.
