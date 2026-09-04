# Known contacts: implementation prompts

Run these eight prompts in order in the same Codex task and feature branch. Finish and verify one step before starting the next. The prompts prepare and implement the feature; the final step prepares a pilot rollout. Production deployment and real test messages require a separate explicit instruction.

## Models

Use **GPT-5.6 Sol, High reasoning** for the whole sequence if you prefer one model. My recommendation is based on the cross-cutting database, messaging, and reporting work. Use **Sol, Extra High (`xhigh`)** for the final review.

For a lower-cost mix, use **GPT-5.6 Terra, High** for Prompt 5 and **Terra, Medium** for Prompt 7. Keep Sol for the other steps. These are workload recommendations, not benchmark guarantees. Both models are advertised as available in this Codex session.

| Prompt | Work | Recommended model | Reasoning |
| --- | --- | --- | --- |
| 1 | Repository check and implementation specification | GPT-5.6 Sol | High |
| 2 | Database, contact services, and authenticated APIs | GPT-5.6 Sol | High |
| 3 | Automatic SMS suppression and owner notifications | GPT-5.6 Sol | High |
| 4 | Inbox classification, Reports, and weekly recap | GPT-5.6 Sol | High |
| 5 | Settings and lead controls | GPT-5.6 Terra or Sol | High |
| 6 | CSV/vCard import and repeatable merge | GPT-5.6 Sol | High |
| 7 | Supported phone contact picker | GPT-5.6 Terra or Sol | Medium |
| 8 | Integration review, fixes, and pilot preparation | GPT-5.6 Sol | Extra High |

Official model references: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [OpenAI model catalog](https://developers.openai.com/api/docs/models). OpenAI describes Sol as a flagship model for complex professional work and Terra as balancing intelligence and cost. Select the model and reasoning in Codex before submitting each prompt.

## Shared instructions — paste once before Prompt 1

```text
We are implementing known-contact handling for Relay NW in this repository. Apply these rules throughout the following numbered prompts and record them in docs/impl-specs/known-contacts.md so work can resume accurately if context changes.

Product behavior:
- A known contact is a number deliberately imported or saved by the owner. Previous calls, existing lead names, and manual replies alone do not make someone a known contact.
- New contacts default to automatic missed-call SMS suppressed and classification unclassified. Importing contacts does not create leads.
- Unclassified contacts and customers remain in the business inbox and Reports. Customers can explicitly be made eligible for automatic texts again.
- Personal contacts always have automatic texts suppressed. Their existing and future calls appear in a recoverable Personal view and are excluded from business Reports and recaps. Preserve call, message, voicemail, and booking records.
- Keep missed-call owner notifications according to existing account preferences. Contact suppression applies to caller automation.
- Manual texting is available through Relay's existing composer and reply endpoint. Recipient opt-outs and account texting eligibility still apply. A manual reply does not re-enable automatic texts.
- Reclassifying or removing a contact updates the grouping of retained history. Removing a contact restores ordinary eligibility for future calls; it never sends a backlog of skipped messages or rewrites past delivery outcomes.
- Contacts are scoped to an account and matched by exact validated, normalized phone number. Never match by name or phone suffix. One person's multiple numbers can have separate entries.
- Reimports preserve existing classification, texting preferences, and owner-entered names. Never infer that imported contacts are personal or that contact membership grants texting consent.

Working rules:
- Read applicable repository instructions and inspect the current branch/diff. Preserve unrelated work. Use one feature branch for the sequence; if a new branch is needed, use codex/known-contacts.
- Implement only the requested step plus necessary prerequisites. Resolve routine implementation choices without asking me to reconfirm this specification.
- Reuse existing authentication, tenant isolation, telephony, UI, and test patterns. Extend both supabase.sql and a dedicated migration where needed.
- Use local/test resources for migrations and verification. Keep production deployment, production data changes, and real SMS/email/push delivery outside these prompts.
- Keep docs/impl-specs/known-contacts.md current with decisions, completed steps, verification evidence, and remaining work. Do not mark a step verified if you could not run its required checks.
- At the end of each step, report the changed behavior, relevant verification, and any concrete blocker. Finish that step before proceeding to the next numbered prompt.
```

## Prompt 1 — Verify the architecture and write the specification

Model: **GPT-5.6 Sol · High**

```text
Implement Step 1 of the known-contacts sequence: inspect the current repository and write a concrete implementation specification at docs/impl-specs/known-contacts.md. Apply the shared instructions.

Verify the actual missed-call entry points, SMS provider boundary, manual reply flow, tenant/write permissions, lead grouping/search/count RPCs, Reports, weekly digest, monitoring, and account export/deletion. Use current code as the source of truth. Useful starting points include lib/missed-call.ts, lib/supabase/{leads,messages,reports,types}.ts, app/api/leads/[id]/reply/route.ts, app/leads, app/settings, app/api/digest/weekly/route.ts, and supabase.sql.

Specify the minimal schema, APIs, contact classification and SMS policy, name precedence, merge rules, historical grouping behavior, and validation cases needed for the remaining seven steps. Keep contact preferences separate from recipient opt-outs and Personal classification separate from Trash. Explain how account-scoped historical replies and revenue are filtered consistently, including unlinked inbound messages.

Define suppression precedence as account texting disabled, recipient opted out, known-contact policy, then cooldown. Contact names/classification must still resolve when texting is disabled. Preserve existing idempotency and call capture. Define the behavior when contact lookup fails and when a contact changes during an in-flight send; do not promise to recall provider-accepted messages.

Write the file-level implementation checklist and migration/deployment order. Record current relevant baseline test results without repairing unrelated failures. This step produces the specification only; application implementation starts in Step 2. Make reasonable decisions consistent with the agreed product behavior and report any genuine incompatibility found in the code.
```

## Prompt 2 — Build the database and contact APIs

Model: **GPT-5.6 Sol · High**

```text
Read docs/impl-specs/known-contacts.md and implement Step 2: the contact data foundation and authenticated APIs.

Add account_known_contacts with a unique account/normalized-phone key, optional display name, classification, automatic-SMS policy, source, and timestamps. Enforce Personal => automatic SMS suppressed. Add the minimal indexes, constraints, RLS/grants, migration, and TypeScript types required by the specification. Preserve compatibility with existing accounts that have no contacts.

Implement account-scoped lookup, paginated search/list, create, update, delete, and a reusable merge service. Follow existing write-access rules and derive account scope from authenticated server context. Reimports must preserve existing owner decisions and be safe under duplicate/concurrent requests. Validate phone numbers before storing; the current phone helper alone may be too permissive for arbitrary uploaded input. Avoid a broad phone-format refactor unless necessary for correctness.

Store only needed contact fields and operational metadata. Integrate contacts into the existing account export/deletion lifecycle; ordinary lead cleanup must not silently remove suppression preferences.

Test tenant isolation, authorization, equivalent phone formats, invalid/ambiguous numbers, duplicate upserts, policy constraints, and deletion. Validate the migration on an available local/test database and clearly report if real SQL/RLS execution was unavailable. Update the specification with the exact service/API contracts for subsequent steps.
```

## Prompt 3 — Enforce suppression in the SMS flow

Model: **GPT-5.6 Sol · High**

```text
Read docs/impl-specs/known-contacts.md and implement Step 3: enforce known-contact suppression for automatic missed-call SMS.

Integrate the contact service into lib/missed-call.ts and every verified automatic missed-call send or retry path. Preserve call/lead creation, signed-webhook handling, provider abstraction, duplicate protection, and cooldown behavior. Resolve contact metadata for display and owner notifications even when account SMS is disabled.

Add skipped_known_contact throughout the SQL constraints, types, status displays, notification wording, and provider-action evidence needed for this step. Follow the documented suppression precedence. Record a known-contact skip as intentional suppression with no automatic retry. If lookup fails, retain call capture and existing owner alert delivery, withhold caller SMS, and record an actionable check failure rather than leaving the lead pending or pretending a provider send occurred.

Check current contact policy at the final eligibility decision before sending. Document the in-flight boundary and test contact changes against it. No removal, reclassification, or feature rollback may silently replay previously skipped messages.

Keep manual replies available under existing opt-out and texting-enabled checks. A manual reply must preserve the historical automatic-SMS outcome and the contact's future suppression policy.

Add behavioral tests for unknown callers, suppressed contacts, enabled customers, Personal contacts, opt-out precedence, disabled accounts, lookup failures, cooldown, duplicate/concurrent webhooks, and an identical number in two accounts. Verify provider.sendSms is never called for suppressed callers. Use existing tests to check for call-capture regressions, then update the specification.
```

## Prompt 4 — Apply Personal classification to inbox and Reports

Model: **GPT-5.6 Sol · High**

```text
Read docs/impl-specs/known-contacts.md and implement Step 4: consistent contact classification across inbox queries, counts, Reports, and weekly recaps.

Update the server-side lead grouping/search/count RPCs and their client projections so Personal calls appear in a recoverable Personal view. Unclassified and Customer contacts remain in business views. Keep Personal classification independent of Trash and of existing lead statuses, bookings, messages, and voicemail history. Contact changes must affect all matching retained calls within the account, across pagination, and be reversible.

Apply the same business-activity rules to missed calls, replies, response-time metrics, bookings/revenue, dashboard counts, and the weekly digest. Inspect direct inbound-message counts and unlinked messages so personal replies cannot leak into business totals. Keep raw operational call-capture monitoring complete.

Expose intentional known-contact suppression separately from SMS failures and successful sends. Use contact names consistently without overwriting owner-entered lead names or changing historical delivery evidence. Ensure Personal-only activity does not trigger a misleading business recap.

Test a mixed account containing Personal, Customer, unclassified, unknown, opted-out, and trashed callers, including multiple calls and replies from each. Verify pagination/search, tab counts, Reports, and the digest agree. Test reclassification and removal restoring visibility without restoring records that were independently trashed. Update the specification for the UI step.
```

## Prompt 5 — Build Settings and lead controls

Model: **GPT-5.6 Terra or Sol · High**

```text
Read docs/impl-specs/known-contacts.md and implement Step 5: the owner-facing contact controls using the existing APIs and business rules.

Add a searchable, paginated Contacts section in Settings with manual add, name edit, Personal/Customer/unclassified classification, customer automatic-text preference, and removal. New contacts start with automation off. Clearly explain the future-call effect of removal or re-enabling automation. Respect the existing account roles and visual design.

Add separate lead-drawer actions for “Turn off automatic texts” and “Mark as personal,” with clear immediate feedback and a way to undo or reclassify. Connect the Personal view to the existing inbox navigation. Keep names, counts, filters, and optimistic updates consistent after saves, failures, refreshes, and navigation.

For a known contact show “Not auto-texted: known contact” when that is the recorded reason. “Text them anyway” should open the existing composer with the account's appropriate booking/reply template ready for review. Send through the existing manual reply API only after the owner taps Send. Preserve opt-out messaging and disabled-texting behavior.

Check the resulting UI at desktop and mobile widths, including keyboard use, loading, empty, validation-error, and save-error states. Use meaningful interaction tests where needed and visually inspect the actual pages. Do not introduce a separate messaging system. Update the specification with verification and any device checks still outstanding.
```

## Prompt 6 — Add CSV/vCard import and merging

Model: **GPT-5.6 Sol · High**

```text
Read docs/impl-specs/known-contacts.md and implement Step 6: CSV and vCard import into the contact list.

Build Choose file -> Preview -> Review -> Import -> Result. Support common Google Contacts CSV and Apple/iCloud vCard exports with multiple phone fields; use fixtures representative of the supported formats. Offer CSV column mapping when automatic mapping is ambiguous. Handle supported quoting, multiline fields, vCard folding/escaping, and international phone formats. Report unsupported or ambiguous values rather than silently guessing. Select a maintained parser if justified and verify its current documentation.

Preview names and phone numbers, duplicates, conflicts, invalid rows, and the expected action. Default new entries to unclassified with automatic texting suppressed. Allow selected contacts to be marked Personal; never classify the entire address book as personal by assumption. Importing contacts must not create leads or send messages.

Use the shared account-scoped merge service. Reimports and retries must not overwrite existing classifications, texting preferences, or owner-entered names. Normalize and validate on the server, impose explicit file/row limits, and give accurate added/existing/rejected counts. Define clear behavior for partial batch failure and make retry safe. Retain only the allowed contact fields and discard raw uploaded content; do not log address-book contents.

Test both formats, duplicate numbers within/across files, multiple numbers per contact, malicious/untrusted field text, ambiguous numbers, repeat imports, interrupted retries, tenant isolation, and preservation of owner decisions. Visually verify preview and results at mobile and desktop sizes. Update the specification.
```

## Prompt 7 — Add the supported phone picker

Model: **GPT-5.6 Terra or Sol · Medium**

```text
Read docs/impl-specs/known-contacts.md and implement Step 7: an optional native contact picker where the browser supports it.

Verify current browser documentation, then feature-detect navigator.contacts and the required properties. Request only name and telephone numbers, from a direct user gesture in a supported secure context. Support multiple selected contacts and multiple numbers per contact. Feed the result into the same preview, validation, and merge flow as file import.

Keep manual entry and CSV/vCard upload readily available. Do not advertise ordinary iPhone Safari support without verified evidence, require experimental browser settings, or claim ongoing contact synchronization. Cancellation should leave existing data unchanged. Exposed-but-failing APIs, missing names/numbers, and permission errors should lead to a usable fallback.

Verify supported, unsupported, canceled, and rejected API responses using focused tests. Perform real Android Chrome and iPhone Safari checks if devices are available; distinguish those results from mocks or desktop emulation. Update the specification and record any remaining physical-device checks.
```

## Prompt 8 — Review, fix, and prepare the pilot

Model: **GPT-5.6 Sol · Extra High (`xhigh`)**

```text
Read docs/impl-specs/known-contacts.md, review the complete feature diff, and implement Step 8: integration verification, necessary fixes, and a concrete pilot rollout plan.

Trace real code paths from signed missed-call webhooks through contact matching, suppression, owner notifications, manual replies, inbox views, Reports, weekly recaps, imports, and account lifecycle handling. Check the database constraints/RLS as well as application checks. Find and fix actionable feature defects; inspect behavior rather than relying only on source-string tests.

Verify these outcomes with test-provider data: Personal receives no caller auto-SMS; imported Customer remains visible and can receive an explicit manual reply; an enabled Customer follows ordinary SMS gates; opted-out callers cannot receive manual or automatic messages; unknown callers retain existing behavior; lookup failures preserve calls without texting; repeated imports preserve decisions; duplicate webhooks do not double-send; account boundaries hold; and reclassification/removal restores grouping without replaying skipped texts or changing historical delivery truth.

Run the repository's required typecheck, lint, build, and relevant regression tests, plus local/test migration verification where available. Distinguish new failures from pre-existing failures and unperformed checks. Review mobile/desktop screens and the physical-device evidence for import. Stop expanding testing once the agreed risks and required gates are covered.

Write docs/operations/known-contacts-pilot.md with the exact migration/application deployment order, readiness evidence, remaining blockers, and a Ryen pilot procedure using explicitly designated test numbers. Include observing suppression, lead capture, owner alerts, and Reports. Design rollback so existing contact protections remain enforced; if that cannot be maintained, pause caller automatic SMS while preserving call capture. Do not use a rollback switch that silently resumes texting protected contacts.

Finish with a concise release-readiness verdict and the precise next action. Prepare the pilot without deploying production changes or sending real messages during this step. Update the specification to accurately identify what is complete and what still requires rollout or real-device verification.
```
