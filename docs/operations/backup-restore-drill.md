# Backup-and-restore drill

**Status:** TEST REQUIRED. This repository contains no retained proof of a successful database restore.

**Safety:** This runbook is a plan, not authorization. Do not start a restore, clone, data export, DNS change, credential change, or test-environment deletion without an approved drill ticket and explicit owner authorization.

## Recovery policy to approve before the drill

| Decision | Approved value | Owner |
|---|---|---|
| Production recovery point objective (RPO) | __________ | __________ |
| Production recovery time objective (RTO) | __________ | __________ |
| Supabase plan / backup mechanism | Daily / PITR / other: __________ | __________ |
| Recovery retention window | __________ | __________ |
| Off-site logical backup cadence and encrypted location | __________ | __________ |
| Supabase Storage object backup method | __________ | __________ |
| Drill cadence | Recommended quarterly; approved: __________ | __________ |
| Restore executor / verifier | __________ / __________ | __________ |

Supabase paid projects provide managed database backups with plan-dependent retention; PITR provides finer recovery points. Database backups do **not** contain Storage API object contents, and a restore can require manual reconfiguration of non-database project settings. Confirm the current plan in Database → Backups. [Supabase database backups](https://supabase.com/docs/guides/platform/backups)

## Phase 1 — non-mutating backup audit

1. Create an approved drill ticket with scenario, source project reference/name, target recovery point, RPO/RTO, executor, verifier, data-handling location, rollback, and disposal approval.
2. In Supabase production → Database → Backups, record without exposing credentials:
   - plan and database/Postgres version;
   - Daily versus PITR;
   - earliest and latest recovery point in an unambiguous UTC timestamp;
   - last completed backup/recovery point;
   - restore-to-new-project availability;
   - region and recovery retention;
   - whether subscriptions/replication slots require handling.
3. Compare backup age with the approved RPO. If it exceeds RPO, stop and mark the control failed; do not “fix” or enable a paid feature without authorization.
4. Inventory data outside database backup scope: Supabase Storage greeting/audio objects, Twilio recordings/messages/call logs, Stripe records, Resend deliveries, Vercel environment configuration, DNS, webhook endpoints, and Sentry data. Assign a restore/reconciliation owner for each.
5. Record source baselines using counts/metadata only—never export caller bodies into the ticket:
   - migration/schema commit;
   - row counts for `accounts`, `account_users`, `leads`, `calls`, `messages`, `inbound_messages`, `opt_outs`, `webhook_events`, `account_audit_events`, `platform_operators`, and `platform_audit_events`;
   - count of active accounts/operators and count of RLS-enabled tables;
   - three preselected synthetic or owner-approved test record IDs and timestamps;
   - Storage bucket names and object counts, without public URLs or object contents.

## Phase 2 — authorized restore to an isolated project

Use **Restore to a New Project** when available so the production project is not overwritten or made unavailable. The new project is database-only; API keys, Auth settings, Storage objects/settings, Edge Functions, Realtime settings, and some extensions/settings may require manual reconfiguration. [Supabase restore to a new project](https://supabase.com/docs/guides/platform/clone-project)

1. Verifier confirms the selected recovery point is before the simulated failure and within retention. Record the UTC timestamp.
2. Executor starts the restore-to-new-project from the production backup page only after the authorization checkpoint. Name the target clearly `relay-drill-YYYYMMDD`; never reuse the production project name.
3. Start the RTO timer when the authorized restore action begins. Record provider status transitions and completion time.
4. Restrict target project membership to the drill team. Use new **drill-only** API credentials; never copy a production service key into development tooling.
5. Do not attach the restored database to the production domain/deployment. Create an isolated temporary deployment only if the application layer must be tested.
6. Set outbound-impact controls in the isolated deployment:
   - `SMS_ENABLED=false`;
   - sandbox/test Stripe credentials only;
   - Twilio test credentials or no outbound-capable credential;
   - Resend test/sink recipient or no sending credential;
   - non-production `APP_BASE_URL`, alert destination, Sentry environment, cron secret, and OpenAI project;
   - no production webhook, cron, DNS, or phone-number routing changes.
7. Reconfigure only the minimum non-database settings required for the drill and record each as a recovery dependency.

## Phase 3 — validation

Run these read-only SQL checks in the restored project and retain results with customer content redacted:

```sql
select current_database(), now();

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
order by relname;

select 'accounts' as relation, count(*) from public.accounts
union all select 'account_users', count(*) from public.account_users
union all select 'leads', count(*) from public.leads
union all select 'calls', count(*) from public.calls
union all select 'messages', count(*) from public.messages
union all select 'account_audit_events', count(*) from public.account_audit_events
union all select 'platform_audit_events', count(*) from public.platform_audit_events;

select status, count(*)
from public.platform_operators
group by status
order by status;
```

Then verify:

1. Expected schema objects, constraints, indexes, RLS state, restricted policies, and service-role-only functions exist.
2. Restored counts are explainable relative to the source baseline and selected recovery point. No row newer than the recovery point is expected.
3. Each preselected synthetic/approved record exists or is correctly absent based on its timestamp.
4. A service-role read scoped to test Account A cannot return Account B rows; an anon/authenticated direct read of protected tables is denied.
5. Authentication works for a dedicated drill user; a revoked `platform_operators` row remains unable to enter `/ops`.
6. With isolated drill credentials, run `npm run security:check`, `npm test`, `npm run typecheck`, `npm run build`, and the read-only portions of `npm run verify:account -- <drill-slug>` / `npm run verify:billing` that the ticket explicitly permits.
7. Application smoke: login, account selection, lead list read, settings read, reports read, `/ops/team`, account workspace, and monitoring render. Do not create a customer call, SMS, email, charge, refund, or subscription.
8. Storage reconciliation identifies which greeting/recording objects would need separate recovery. Do not claim success for audio that only has database metadata.
9. Provider reconciliation explains records newer than the database recovery point (for example Stripe events or Twilio callbacks) and defines an idempotent replay/manual repair plan; do not replay in the drill unless separately authorized.
10. Stop the RTO timer when the verifier confirms the restored application meets the success criteria.

## Success criteria

The drill passes only when all are true:

- [ ] The backup/recovery point is within the approved RPO.
- [ ] Restore completed in an isolated project within the approved RTO.
- [ ] Required schema, RLS, constraints, functions, and audit tables are present.
- [ ] Count differences and preselected record results match the chosen recovery point.
- [ ] Tenant-isolation and revoked-operator checks pass.
- [ ] Application read-only smoke and repository verification commands pass.
- [ ] No real customer message, call routing change, email, payment, refund, subscription, or production webhook occurred.
- [ ] Storage and every external-provider gap has a named recovery/reconciliation action.
- [ ] Observed RPO, observed RTO, evidence links, failures, owners, and due dates are recorded.
- [ ] Executor and independent verifier sign the result.

Any missing evidence is a failed or partial drill, not a pass.

## Closeout and disposal

Export only redacted drill evidence. Review temporary Vercel/Supabase members and credentials. With separate explicit authorization, revoke drill credentials and delete the temporary deployment/project according to the disposal ticket; record provider deletion evidence. Do not delete the drill project merely because the exercise ended if evidence review or legal retention requires it.

**Result:** [ ] Pass  [ ] Partial  [ ] Fail

**Observed RPO:** __________  **Observed RTO:** __________

**Executor:** __________  **Verifier:** __________  **Date:** __________
