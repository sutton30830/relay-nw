# Known-contact handling — implementation specification

Status: **Steps 1–4 implemented and deployed to production on 2026-09-04. Step 5 is implemented and verified locally but not deployed. Steps 6–8 are not implemented.** All three production database migrations passed before the Steps 1–4 application deployment. The current Step 5 regression suite passes 672/672. See §17–18 for the production release and §19 for Step 5 behavior and verification. Earlier local-only and blocker statements below describe their respective checkpoints.

Local database prerequisite: **complete**, following the separately authorized setup on 2026-09-03. PostgreSQL 17.11 now runs in the repository's private socket-only cluster, with the checked-in schema loaded and real role/RLS/RPC/constraint checks passing. See [local database operations](../operations/local-test-database.md). The Step 2 contact migration and feature-specific SQL/RLS checks have also passed (see §14).

Inspected on 2026-09-03 America/Los_Angeles (2026-09-04 UTC). Repository: `/Users/suttonlowry/Documents/relay-nw copy`. Feature branch: `codex/known-contacts`, created from `codex/pwa-owner-alerts` at `0799c38a915d44e41014528bcf4d5b2ac2e0dd41`. Sections 1–13 record the original specification; later implementation and release sections identify completed and deployed behavior.

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
| 3 — SMS suppression | Complete | Ordered/final contact gate, intentional and blocked statuses, independent owner alerts, zero-attempt/idempotent attempt evidence, UI/monitoring distinction; 659 regression tests and 20 real SQL checks passed. |
| 4 — Inbox/Reports | Complete locally | Contact-aware SQL projections, Personal view, historical business aggregates, and recap filtering implemented. 30 SQL checks and 8 feature tests pass; full regression has one unchanged monitoring failure (§16). |
| 5 — UI | Not started | Build contact and Personal controls against verified APIs. |
| 6 — CSV/vCard import | Not started | Build preview/merge and validate representative exports. |
| 7 — Phone picker | Not started | Add supported-browser adapter and record device evidence. |
| 8 — Review/pilot preparation | Not started | Complete release gates and write pilot runbook. |

Next numbered step when requested: **Step 5 — Settings and lead controls**. Steps 2–4 supply contact APIs, caller suppression, current history grouping, and business filtering. Owner contact-management/import controls remain unimplemented. No production resources or real messages were used.


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

Repeatable commands and test files above are the durable evidence. Detailed transient logs: `/private/tmp/relay-known-contacts-step2-tests.log` and `/private/tmp/relay-known-contacts-step2-sql.log`. No unrelated failures were repaired. No concrete Step 2 blocker remains. At Step 2 completion, Steps 3–8 remained outstanding. Step 3 completion is recorded below; business/Personal history grouping remains future work.


## 15. Step 3 implementation and verification

Completed locally on 2026-09-03 America/Los_Angeles (2026-09-04 UTC), continuing `codex/known-contacts` from the pushed Step 2 checkpoint `bd787b5`. Applicable repository instructions and the branch/diff were checked again. The pre-existing unrelated document/Word changes were preserved. This is application implementation and local verification, not a production rollout.

### Caller gate and notification behavior

`lib/missed-call.ts::handleMissedCall` remains the common automatic caller SMS entry point. Both forwarding-mode voice ingestion and missed-call completion (including the dial-status compatibility alias) already invoke it; no new send/retry route was introduced. Durable lead creation, signed first-call activation, duplicate exit, call linkage, and the existing cooldown's creation-time/ID tie-break remain intact. Earlier calls, lead names, manual replies, and START do not save contacts.

After capture, Web Push starts independently. Contact metadata is read even with account texting disabled; contact names are passed to owner email/SMS without writing them into leads. The gate order is now disabled → opted out → contact policy → cooldown. Only a Customer with explicit `standard` proceeds past the contact gate. A malformed Personal/standard combination also suppresses defensively. Disabled and opted-out reasons survive a metadata failure, which instead records a separate `known_contact_lookup` operational issue. Other required lookup failures block caller submission.

Before an otherwise eligible send, the body/callback metadata are prepared and the existing automatic action key is reserved with `countAttempt: false` and no retry eligibility. Recipient opt-out and contact policy are then read again without caching. There is no awaited owner alert or bookkeeping operation between the final contact read and `provider.sendSms`. A contact committed before that database read's snapshot affects the decision. An edit committed after the read can race with submission; an initiated or accepted provider request cannot be recalled. Settings/help must carry this explanation when contact management is added in Step 5.

All terminal outcomes independently attempt the configured email/SMS notifications and await the already-started push. This includes repeat callers and checks that blocked texting. A failure in an alert, administrator notification, or terminal status/action write cannot fall through to caller submission. The provider-send catch is separate from post-acceptance bookkeeping, so subsequent recording/notification failures cannot mark an accepted send failed. Owner SMS still obeys texting eligibility, sender availability, preferences, and the self-call guard; push remains independent of A2P.

### Statuses, evidence, and displays

- Dedicated additive migration: `docs/migrations/2026-09-04-known-contact-sms.sql`, applied locally **after** the Step 2 contact migration. `supabase.sql` and `SmsStatus` include `skipped_known_contact` and `blocked_pre_send`. Old status values and records are retained; no backfill or replay occurs. Apply this migration before deploying this code in any separately authorized rollout.
- Contact suppression: automatic action key `automatic_missed_call_sms:{leadId}`, provider `relay`, status `known_contact`, internal status `suppressed`, expected suppression true, zero attempts, retry `never`. No outbound message row is inserted.
- Required pre-send failure (including inability to reserve evidence): lead `blocked_pre_send`, provider `supabase`, status `pre_send_check_failed`, internal status `failed`, expected suppression false, zero attempts, retry `never`. Diagnostics identify the unavailable check using fixed stage labels without logging contact contents. Guidance points to Operations and an explicit manual reply/call, never an automatic replay.
- New `record_automatic_sms_attempt(uuid,text)` RPC and `recordAutomaticSmsAttempt(accountId, actionKey)` service set the matching account's automatic action count to at least 1 **after actual provider invocation resolves or rejects**, or after its signed automatic callback. They cannot mark a suppressed action, touch a different account/action type, overwrite terminal status, or increment twice when callback and send completion race. The RPC uses invoker rights and a fixed search path, revoked public/client execution, and service-role access. Send completion and callback report the same one submission; processing reservations remain zero. If the process exits before recording the outcome, a signed callback can repair attempt evidence. No transactional guarantee with the external provider is implied.
- `lib/telephony/webhook-services.ts` records the idempotent attempt for signed `auto_text` callbacks with an action key. Manual callbacks retain their separate message-only behavior and never change the automatic contact policy or lead SMS outcome.
- `lib/email.ts` and owner SMS now use bounded contact names and direct `/leads/{id}` links. Email HTML uses the existing escaping helper. Push content is unchanged. Known-contact and blocked-check wording never describes an intentional skip as a carrier failure.
- `lib/twilio/sms-delivery.ts`, lead card, and shared lead helpers show “Not auto-texted: known contact” and “Not texted: texting checks unavailable.” New blocked leads receive the existing attention treatment. `hasSmsDeliveryFailure` keeps blocked checks out of the existing `smsIssues` totals and optimistic count deltas; a separate aggregate blocked count belongs to Step 4.
- Operations monitoring reads actual attempt counts/provider identifiers. Zero-attempt reservations and intentional skips do not count as SMS submissions/failures. A distinct `pre_send_check_failed` health alert covers failed eligibility/metadata reads, deduplicated by lead. A stalled zero-attempt reservation does not hide a pending-call problem; recorded intentional suppression does. Raw call-capture evidence remains included. Existing dashboard query caps and business-report definitions are not broadened here.

Manual reply implementation remains on the existing composer/route and its opt-out, account texting, and idempotency checks. The new tests prove a Personal contact can be manually replied to when eligible, while its suppression policy and historical auto-text status stay unchanged. Removing/reclassifying a contact affects future automatic eligibility; duplicate webhook replays still exit without sending.

### Verification evidence

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | **659 passed, 0 failed/skipped** | Full repository suite including new contact SMS tests and signed-callback attempt reconciliation. Existing activation, signed ingress, duplicate/cooldown, manual reply, tenant, push, and provider regressions passed. |
| `node --test tests/known-contact-sms.test.mjs` | **31 passed** | Unknown/default/enabled/Personal policies; account and opt-out precedence; initial/final failures; before/after-send barriers; two tenants; removal/replay; parallel duplicate calls; all-channel failure isolation; manual replies; escaped names; statuses and monitoring aggregates. |
| Final focused pipeline run | **55 passed, 0 failed/skipped** | `node --test tests/known-contact-sms.test.mjs tests/pipeline-failure-handling.test.mjs`, repeated after final diagnostic wording and monitoring changes. |
| `npm run test:contacts:db` | **20 passed, 0 failed/skipped** | Real PostgreSQL 17.11: fresh schema and ordered upgrade from original baseline through Steps 2–3, repeated migrations, actual client-role restrictions, status constraints, zero-attempt suppression, no retry claim, tenant-scoped attempt marking, and idempotence with an already-delivered callback. All Step 2 integrity/concurrency checks still pass. |
| Local Step 3 migration | **Passed** | Applied to the existing private `relay_nw_test` database using the guarded local runner; no production connection. |
| `npm run typecheck`, `npm run lint`, `git diff --check` | **Passed** | TypeScript, full configured lint scope, tracked whitespace validation. |
| Production build, browser/device review, hosted Supabase HTTP integration, real delivery | **Not run in Step 3** | SQL uses the real local engine; app/provider/notification tests use synthetic fixtures and module mocks. No real SMS/email/push was sent. No deployment or production data changes. |

Transient logs: `/private/tmp/relay-known-contacts-step3-tests.log`, `/private/tmp/relay-known-contacts-step3-focused.log`, `/private/tmp/relay-known-contacts-step3-final-focused.log`, and `/private/tmp/relay-known-contacts-step3-sql.log`. Commands and test files are the durable evidence. Existing fixture changes supply the mandatory contact/attempt service dependencies; no production fallback treats a missing contact service as an unknown caller.

No concrete Step 3 blocker remains. Step 4 must still add current-contact joins, name precedence across cards/conversations/search, Personal versus Trash grouping, complete business/reply/revenue filtering, and separate aggregate skip/blocked counters. Steps 5–7 add the owner controls/imports/picker, and Step 8 remains the release gate. Do not treat this partial feature as ready for a production pilot or deploy an older app that ignores saved suppression.


## 16. Step 4 implementation and verification

Implemented locally on the existing `codex/known-contacts` branch after `75ddee3` (Step 3). This section supersedes the Step 3 “remaining work” paragraph for inbox/reporting. Step 4 is recorded in a separate feature commit. Pushing and deployment are separate operations. Unrelated operations/checklist edits and local documents were preserved.

### Final read contracts and behavior

- `docs/migrations/2026-09-04-known-contact-views.sql` and the matching appended definitions in `supabase.sql` add a `security_invoker` view, `lead_contact_context`. It projects the existing owner-facing lead columns plus raw contact metadata, `display_name`, and `is_personal`. It never updates a lead, call, message, booking, or delivery outcome.
- `lead_inbox_context(p_account)` preserves one newest card per **raw phone string and live/Trash bucket**, with `created_at DESC, id DESC` tie-breaking. The contact join uses account identity and the existing canonical phone helper; historical formatting variants share contact metadata while keeping their existing separate cards.
- `lead_inbox_counts_v2(p_account)` returns a JSON object with the existing `_count`/value fields plus `personal_count`, `sms_blocked_count`, and `known_contact_skipped_count`. Business counts exclude Personal and Trash. SMS failures mean failed/undelivered; blocked checks and intentional skips remain separate. Known-contact skips count current business cards, not unique people.
- `search_lead_inbox_v2(p_account,p_filter,p_query,p_limit,p_offset)` returns `{leads,total}`. Each lead includes the contact projection and `call_count` across all raw-phone call rows, including Personal and Trash. Filtering and literal case-insensitive search run before paging. `total` stays correct even when the requested page is empty. Query length is capped at 200 characters; page size is 1–250. Search covers effective display name, phone, original lead message, notes, voicemail summary, and transcript. This preserves the existing server search scope; it does not introduce an all-message search feature.
- Legacy `status='booked'` rows remain booked outcomes and appear in Closed, matching the existing TypeScript normalization to `dead` plus a booking flag. This resolves the previous server/client mismatch without rewriting stored statuses. Historical booking aggregates still require an actual `booked_at`, preserving their existing date attribution.
- Personal is a filter independent of status and Trash. Customer/unclassified contacts remain business calls. Personal cards/conversations retain names, call records, messages, voicemail, and booking controls. Trash includes both classifications, and a restored call follows its **current** contact classification. Reclassification/removal recomputes retained history without restoring independently trashed rows or changing past SMS outcomes.
- Display names use nonblank owner-entered `leads.name`, then contact name, then the existing unknown/phone presentation. Raw editable names remain raw; contact fallback is never saved as a lead-name edit. Phone numbers remain visible beside contact-name headings.
- All new SQL surfaces deny `public`, `anon`, and `authenticated`; service-role execution/select is explicitly granted. Functions are invoker functions with a fixed search path and account predicates. The same phone in another account supplies neither contact metadata nor reply linkage.

### Business metrics and recap

- `account_business_replies(account,since,until)` counts `inbound_messages` once. An inbound `messages` mirror can supply a verified link only when account and provider message ID match. The existing `(account_id,twilio_message_sid)` uniqueness prevents duplicate mirrors in one account; the existing global uniqueness on `inbound_messages.message_sid` remains unchanged.
- Current Personal senders are excluded even without a lead. Verified linked Personal/Trash leads are also excluded. Unlinked replies from senders with only trashed matching calls are excluded; live business history or no history remains eligible. Foreign-account mirrors cannot supply a link. `uniqueReplyLeads` counts actual distinct verified links, and `unlinkedReplyCount` reports eligible unlinked messages separately.
- `account_business_recovery_stats` aggregates the complete eligible dataset in SQL. Calls/text outcomes use lead creation time; bookings/revenue use booking time; replies use inbound creation time. Period bounds are inclusive `since`, exclusive `until`; null means unbounded. Reports remain a current-card snapshot, while the recap remains historical activity.
- `account_business_response_stats` computes the median first-outbound delay for eligible missed-call leads created in the period. Existing response semantics are preserved: the outbound can fall after the period, its delivery status is not newly restricted, and negative intervals are excluded. Suppression does not invent an outbound event.
- Reports show intentional known-contact skips separately from failed texts and held texting checks. Weekly email copy makes the same distinction. The digest uses one shared seven-day window for every account and skips Personal-only activity. Query failure is a failed account check-in, not a zero-activity recap.
- Operational call-capture monitoring, activation evidence, `getLastRecoveredCallAt`, and `getSignedCallVerificationAt` remain unchanged. Their evidence does not exclude Personal because Personal calls still prove forwarding/capture work.

### Client integration and file checklist

| Files | Completed behavior |
| --- | --- |
| `lib/supabase/{leads,reports,types}.ts` | Typed contact projections, v2 reads, complete SQL metric adapters, new counters; missing projections/RPCs fail visibly instead of using unfiltered fallbacks or fake zero totals. |
| `app/leads/page.tsx`, `_constants.ts`, `_utils.ts`, `leads-list.tsx` | Personal navigation/counts, name fallback/search, client grouping parity, Personal guidance, bounded query input. Real search membership comes from the server; the client does not re-filter an already searched page with different search rules. |
| `app/leads/_inbox-state.ts`, `_hooks/use-leads-inbox.ts` | Existing optimistic bookkeeping extracted into testable helpers. Fresh global counts are rebased with only outstanding edits and current contact metadata. Server-absent rows are never reinserted from stale local state. Failed edits use the current server snapshot, and Undo restores by ID even after the row has left the page. |
| `app/leads/_components/{lead-card,lead-drawer}.tsx`, `app/leads/[id]/conversation-view.tsx` | Consistent fallback names/Personal labels and preserved raw editing/composer behavior. |
| `app/leads/error.tsx`, `app/reports/error.tsx` | Recoverable error states with a retry button when required reads fail. |
| `app/reports/page.tsx`, `lib/email.ts`, `app/api/digest/weekly/route.ts` | Business-only totals and recap eligibility, separate skip/blocked wording, stable digest window. |
| `tests/known-contact-views.test.mjs`, `tests/integration/known-contact-views.mjs` | Behavioral projection/client/digest checks plus real SQL mixed/large-account checks. Existing isolation, report, and UI source contracts updated for the new APIs without weakening tenant restrictions. |

### Verification evidence

| Check | Result | Evidence and limits |
| --- | --- | --- |
| `npm run test:contacts:db` | **30 passed, 0 failed/skipped** | PostgreSQL 17.11; both a fresh full schema and ordered upgrade from the original baseline through Steps 2–4. Each migration is reapplied to verify repeatability. Actual client roles cannot use the new view/functions. Mixed Personal/customer/unclassified/unknown/opted-out/Trash fixtures cover name precedence, canonical variants, tenant identity, literal search, paging, complete counts, linked/unlinked replies, event dates, response medians, reclassification, removal, and restoration. |
| Large real SQL fixture | **Passed** | 2,205 calls (100 Personal) produce 2,105 business cards/bookings and the correct final page/revenue. All 5,205 eligible unlinked replies count, with zero invented unique lead links. Exceeds the previous 2,000/5,000-row reporting limits. |
| `node --test tests/known-contact-views.test.mjs tests/compliance-gaps.pinned.test.mjs` | **22 passed, 0 failed/skipped** | Eight feature tests plus 14 existing pinned contracts, repeated after the final Undo/refresh changes. Tests run actual adapters, helpers, digest route, and email formatter with synthetic data and a mocked provider. No real email is sent. |
| `npm test` | **666 passed, 1 failed, 0 skipped** | The sole failure is unchanged `tests/monitoring-health.test.mjs:198`, which asserts the literal `attemptedLeadIds` exists in `lib/supabase/monitoring.ts`. Both files are byte-for-byte unchanged from Step 3 HEAD (`git diff HEAD --` for both is empty). No other tests failed; the full suite is explicitly **not green**. The earlier Step 3 recorded 659/659 result is not reproducible from the current unchanged monitoring sources; do not use that old record as a current passing gate. |
| `npm run typecheck`, `npm run lint`, `git diff --check` | **Passed** | Final TypeScript/lint run completed successfully after the Undo and refresh changes. No lint warnings or tracked whitespace errors. |
| Private local migration | **Passed** | Applied the Step 4 migration to the existing socket-only `relay_nw_test` database with the guarded local runner. Integration fixtures use disposable databases created and removed by the test invocation. |
| Browser/device review, production build, hosted Supabase HTTP integration, real delivery | **Not run in Step 4** | SQL/role checks use the real local engine; application/provider checks use mocks. No deployment, production data changes, or real SMS/email/push. |

Transient logs: `/private/tmp/relay-step4-db.log`, `/private/tmp/relay-step4-final-focused.log`, `/private/tmp/relay-step4-final-tests.log`, and `/private/tmp/relay-step4-final-lint.log`. Checked-in test files and commands are the durable evidence.

### Order and remaining work

Apply the foundation migration, the Step 3 SMS migration, then `2026-09-04-known-contact-views.sql` **before** switching the app to these v2 reads. Legacy RPCs remain available; do not roll back to an app that ignores saved contact suppression. No migration removes or backfills history, and no suppressed message is replayed.

Step 5 should build Settings/contact controls and lead quick actions against the existing APIs. After a successful contact mutation, refresh inbox/Reports/current conversation data and global counts; never manufacture contact membership from a name edit or reply. The existing contact API invalidations plus authoritative queries handle all pages, while open views update when refreshed. Preserve the existing conversation window of 25 previous calls and 100 messages per direction; Step 4 does not claim to add full-history pagination or change data retention.

No Step 4 implementation blocker remains. The unchanged monitoring source-contract failure blocks claiming a fully passing repository regression gate and must be resolved before the Step 8 release gate. Contact management, imports, supported-device testing, and production pilot preparation remain Steps 5–8.


### Commit and deployment clarification

The owner requested the Step 4 commit after implementation. Read-only GitHub checks confirmed that remote `codex/known-contacts` still points to Step 2, `bd787b549b4e8ed7a3e31181d4a43f1c81f68b1e`; Step 3 (`75ddee3`) is local. The Step 2 push automatically created a successful **Preview** deployment on 2026-09-04 at 04:02:43 UTC: [Vercel deployment](https://vercel.com/sutton-lowrys-projects/relay-nw/5xaS6L66nhcKjzJuzYMjakP5MpdY), GitHub deployment ID `6257619648`. Earlier “not deployed” wording refers to no intentional production rollout, and should not be read as absence of this automatic preview. The Step 4 commit operation does not push either local commit or run a deployment. Database migrations were verified/applied only locally; preview build success is not hosted-database or production-readiness verification.


## 17. Authorized production release — preparation history (blocker resolved in §18)

On 2026-09-04 the owner explicitly requested deploying Steps 3–4 to production following Step 2. This authorizes the required ordered database migrations and cumulative application deployment; it supersedes the earlier local-only scope for this release. It does not request test SMS/email/push delivery or contact imports.

Read-only Vercel verification found that `www.relay-nw.com` still resolves to production deployment `dpl_5ETwAiQKB35eNDQGHt1FpTZjHZSh`, serving `0799c38a915d44e41014528bcf4d5b2ac2e0dd41` from `codex/pwa-owner-alerts`. Thus the live domain predates the Step 2 commit. Step 1 was documentation and is contained in `bd787b5`, together with Step 2. The release must include that commit plus `75ddee3` and `1d68f02`. Vercel's configured production Git branch is `main`; pushing `codex/known-contacts` alone creates a Preview and is not a production rollout.

Production Supabase is `ghrciuvlbqgmyoxnvidb`. Read-only REST checks through the existing same-project app credential returned missing-schema errors for `account_known_contacts`, `lead_contact_context`, `lead_inbox_counts_v2`, `search_lead_inbox_v2`, and both business-report aggregate RPCs. The schema API also lacks `record_automatic_sms_attempt`. These findings mean Steps 2–4 must be migrated before this application release. No production schema or application changes have been made during preparation.

The previously failing monitoring source-contract test referenced the old variable `attemptedLeadIds`, while the implemented logic correctly uses `handledLeadIds` for both attempts and intentional suppression. The release preparation updates this test to the current name and strengthens its suppression/attempt and missing-attempt predicates. Application monitoring behavior is unchanged. `npm test` now passes **667/667**, typecheck and lint pass, and `npm run security:check` passes. The isolated production build also passed. It uses only tracked release files, existing dependencies, and synthetic environment values; production credentials are not used for local verification. The first sandboxed build could not fetch Google Fonts; the authorized network-enabled retry passed without code changes.

A transaction-wrapped bundle of the three unchanged feature migrations is prepared at `/private/tmp/relay-known-contacts-production-migrations.sql`, with a five-second lock timeout, 90-second statement timeout, and PostgREST schema reload notification. Apply only to the verified production project; if a migration fails, roll back and leave the current production deployment active. The dedicated files in `docs/migrations` remain the durable source of truth.

**Blocker:** Supabase management access requires a fresh browser sign-in. The existing app service credential can read the schema but cannot apply DDL through PostgREST. No stored Supabase CLI management token or database connection credential was available. The Supabase SQL Editor redirects through GitHub sign-in in the in-app browser. Resume after the owner signs in: verify the project, execute the prepared migration transaction, verify schema/functions/role restrictions, deploy the cumulative Git commit to production, and verify the live domain's deployment SHA and safe read-only application endpoints. Do not substitute a successful Preview build for these gates.


Release preparation completed: commits through `fcbd4b13e8de643c26107fad104df075bc871545` were pushed to `origin/codex/known-contacts`, including Steps 3–4 and the corrected monitoring test. The branch push is a Preview trigger only. Production remains unchanged pending Supabase sign-in and the three database migrations. The GitHub sign-in tab for Supabase was retained for owner handoff. Full build evidence is `/private/tmp/relay-release-build.log`; regression, lint, and security logs are `/private/tmp/relay-release-{tests,lint,security}.log`. The temporary production environment export was removed after the read-only checks; re-fetch it if needed after sign-in, and never print credential values.

## 18. Completed production release — 2026-09-04

The owner completed Supabase sign-in and authorized continuing the release. The SQL Editor was verified to belong to **Relay NW**, project `ghrciuvlbqgmyoxnvidb`, before running any DDL. The preflight confirmed the contact table and Step 3 attempt function were absent.

Applied these unchanged, locally tested migrations in order inside one transaction, with the prepared lock/statement timeouts and PostgREST schema reload notification:

1. `docs/migrations/2026-09-03-known-contacts.sql`
2. `docs/migrations/2026-09-04-known-contact-sms.sql`
3. `docs/migrations/2026-09-04-known-contact-views.sql`

The SQL Editor reported **Success. No rows returned**. No contacts were imported, no retained history was deleted or backfilled, and no skipped messages were replayed. The account-deletion function was defined by the migration, not invoked.

Production verification after commit:

| Check | Result |
| --- | --- |
| SQL security/schema query | **9/9 true**: contact-table RLS enabled; anon/authenticated contact-table and view reads denied; client execution denied and service-role execution granted for all 12 checked contact/attempt/inbox/report RPCs; both new SMS statuses constrained; contact table empty; historical phone normalization correct; contact view uses security-invoker rights. |
| Hosted PostgREST reads | **HTTP 200** for contact table/view with `limit=0`, inbox counts, Personal inbox search, recovery totals, and response totals. Aggregate/search checks used a nonexistent account UUID and inspected response shape, without retrieving customer records. |
| Attempt-function availability | Hosted schema API includes `record_automatic_sms_attempt`; the function was not invoked as a production test. |
| Release gates already completed | **667/667** repository tests; **30** real local PostgreSQL checks covering fresh/upgrade/repeated migrations, role restrictions, tenant isolation, and large mixed fixtures; typecheck, lint, **4/4** security checks, and isolated production build passed. |

After database verification, created a fresh Vercel **production** deployment from the exact pushed Git commit `96f1495c6fd432a90e45cb7c8c84689914c44b16` on `codex/known-contacts`. This includes Step 1 documentation, Step 2 foundation, Step 3 suppression, Step 4 inbox/reporting, and the monitoring test correction. Deployment used the Git source and production environment, not the local synthetic build or untracked workspace files.

- Deployment: `dpl_GN88YyCYMFpq1hhtGzdn7FGYWVAR`, **READY**.
- [Vercel release](https://vercel.com/sutton-lowrys-projects/relay-nw/GN88YyCYMFpq1hhtGzdn7FGYWVAR).
- [Live application](https://www.relay-nw.com); immutable deployment URL: `https://relay-hijpaex1h-sutton-lowrys-projects.vercel.app`.
- Vercel's lookup for `www.relay-nw.com` confirmed this deployment ID and exact SHA, with `www.relay-nw.com`, `relay-nw.com`, and `relay-nw.vercel.app` assigned as aliases. Verified by 2026-09-04 17:12 UTC.
- Read-only HTTP checks: home **200**, login **200**, Reports **307** to login, contacts GET **401**. Unauthenticated Leads uses a **200 streamed Next.js response containing the explicit `/login` redirect**, confirmed in both the redirect marker and refresh metadata; it is not an authenticated inbox verification.

No production release blocker remains. Signed-in Relay UI/device review and real SMS/email/push delivery were **not performed** during this rollout. Production contacts remain empty at verification. The release does not claim completion of the full feature or Step 8: owner Settings/quick actions, imports, contact picker support, and the remaining acceptance/pilot work are still Steps 5–8. Do not roll back to an app that ignores saved contact suppression once contacts are in use.

The release record update is documentation-only and may be committed after the deployed SHA. Future feature-branch pushes still create Previews because Vercel's production Git branch remains `main`; they require an explicit production release to change the live site. Unrelated local documents and edits remain untouched.

## 19. Step 5 implementation and verification

Implemented and pushed on `codex/known-contacts` after confirming Vercel production deployment `dpl_AsEzYPeB5pJMKEZApGFcoNLCZXsZ` is **READY** and serves the branch's prior commit `03f71714584b8cd6bcc92e25e8a11eba57452a05` at both Relay domains. Step 5 commit `bc973663730ef6d02eb22c0de214022769575c69` built successfully as Vercel Preview `dpl_6kuSSw8PbmE7NMY9ruY4TsbxusqA`; it has not been promoted to production. It needs no database migration because it uses the Step 2 APIs and Step 4 projections already deployed.

### Owner controls

- Settings now includes a searchable, 20-per-page Contacts section. Owners/admins can manually add, edit, classify, change Customer automatic-text eligibility, and remove contacts. Viewers receive the same account-scoped list without mutation controls. Focus, disabled controls, loading/empty/error states, retry, pagination clamping, and current-version conflict recovery are explicit.
- Manual adds submit only phone and optional display name. The existing server merge creates an `unclassified`, suppressed contact, so no UI request can default a new contact to enabled automation. Existing entries retain their classification, policy, and name. The UI explains that adding creates no lead and sends no message.
- Personal and unclassified edits force `suppress` in the client as well as in database constraints. Only a Customer exposes the future automatic-text checkbox. Copy states that this affects future missed calls, remains subject to account texting/recipient opt-outs, grants no consent, and does not replay past skips.
- Removal uses the contact version and an explicit in-flow explanation. After confirmed removal, retained history is regrouped by authoritative server reads. Trash and past SMS outcomes remain unchanged. Ambiguous network/storage and stale-version failures keep the editor recoverable rather than showing a false success.
- Successful mutations refresh `/settings`, `/leads`, `/reports`, and the current router data. Settings also refreshes its server list after focus when no edit/add form is open. It never derives contact membership from a lead name or reply.

### Lead and manual-reply controls

- The full conversation and fallback lead drawer expose separate **Turn off automatic texts** and **Mark as personal** actions through `/api/leads/{id}/contact`. They pass the projected current contact ID/version when one exists. Confirmed changes update the open lead's contact name/classification immediately, then refresh authoritative inbox/Reports data.
- Each quick action has a version-checked Undo. Undo restores the prior contact classification and policy, or removes only the contact that the quick action just created. Concurrent changes fail with a reload action rather than being overwritten. The full editor remains available for reclassification, Customer re-enablement, name changes, or removal.
- A lead whose recorded SMS status is `skipped_known_contact` shows **Not auto-texted: known contact**. **Text them anyway** fills the existing Relay composer with the first nonblank account reply template and the booking link, without overwriting an in-progress draft. It never invokes the reply endpoint until the owner selects Send. The review state disables desktop Enter-to-send and explains that opt-outs still apply and a manual reply will not enable future automatic messages.
- The composer still uses the existing manual-reply API, idempotency, account-texting gate, and recipient opt-out check. When Relay texting is unavailable, the existing call/text-from-phone alternatives remain; no new sending system or consent path was added. Viewer controls remain read-only.

### Verification evidence

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Vercel preflight | **Passed** | `www.relay-nw.com` resolves to READY deployment `dpl_AsEzYPeB5pJMKEZApGFcoNLCZXsZ`, exact commit `03f7171`, ref `codex/known-contacts`, with both Relay custom domains assigned. This was a read-only check before Step 5 changes. |
| `npm test` | **672 passed, 0 failed/skipped** | Full suite after Step 5. Five new tests cover safe classification/policy patches, preservation of lead names/SMS history, draft behavior, fetch/version conflict contracts, role/error/loading/paging controls, both reply surfaces, and review-before-send. The existing route authorization, opt-out, inbox/report, SMS, account, and provider regressions remain green. |
| `npm run lint` | **Passed** | Full workspace ESLint, no warnings. |
| Clean `npm run typecheck` | **Passed** | Checked the complete application/Step 5 source in an isolated copy excluding four unrelated untracked `route 2.ts` files. A direct workspace typecheck is blocked by those duplicate files' pre-existing missing `notificationId` arguments; Step 5 files have no TypeScript errors. The unrelated files were preserved. |
| Isolated production build | **Passed** | Complete app build with the real Step 5 sources, installed dependencies, and synthetic environment values. No production credential or data was used. |
| Desktop browser review | **Passed** | Actual React/Next UI against a local synthetic contact API at 1280×900: contact list, 23-row pagination, editor, classification copy, and lead conversation controls rendered correctly. |
| Mobile browser review | **Passed** | Actual UI at 390×844: Settings list/add form and lead controls/composer fit without horizontal overflow (`innerWidth`, document/body, conversation, and composer widths all 390px). Touch-size action wrapping and focused form fields were inspected. |
| Interaction states | **Passed with synthetic data** | Verified loading-to-list, Add form focus/copy, successful local save feedback, lead quick controls, skipped reason, and **Text them anyway** draft. The populated draft remained unsent. Error/stale behavior is covered by focused tests and explicit local API responses; no production contact was changed and no real SMS/email/push was sent. |

Step 6 remains CSV/vCard preview, validation, selection, and repeatable merge. Step 7 remains the feature-detected phone picker. Step 8 remains integration review, real-device evidence, and pilot preparation. Do not deploy Step 5 or use customer contacts as test data without a separate release instruction.
