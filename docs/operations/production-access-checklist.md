# Production-access checklist — one page

**Review date:** __________  **Reviewer:** __________  **Approval/ticket:** __________  **Next review:** __________

Complete this before launch, quarterly, and after any access change. Mark **N/A** only with a written reason. Retain evidence in the owner-controlled security folder; never attach secret values or recovery codes.

## Identity and administrators

- [ ] Two named, recovery-capable production owners exist; neither uses a shared daily-use login.
- [ ] Vercel team 2FA enforcement is on; Members shows no noncompliant production member.
- [ ] Supabase organization MFA enforcement is on, or every member has individually verified MFA when the plan cannot enforce it.
- [ ] Twilio account/user 2FA is required; users, roles, account assignments, and recovery ownership are reviewed.
- [ ] Stripe requires two-step authentication for all team members; roles are least privilege; Security history was reviewed.
- [ ] GitHub personal owner and every collaborator use secure 2FA; if organization-owned, secure-method 2FA is enforced.
- [ ] Sentry requires 2FA or uses SSO with IdP MFA; member roles and recovery owners are reviewed.
- [ ] Every Resend team member has MFA; the Team Settings MFA list has no exception.
- [ ] Admin email provider is recorded; all privileged email admins have strong MFA; recovery/emergency access is tested and monitored.
- [ ] `/ops/team` matches the approved Relay operator roster; revoked users and pending invites are explained.
- [ ] Provider administrator/member exports match the incident contact matrix and offboarding roster.

## Credentials and environments

- [ ] The secrets inventory has an owner, purpose, environment, provider record name, creation/rotation date, and next review—never a value.
- [ ] Production, Preview, and Development Vercel scopes were reviewed variable-by-variable.
- [ ] Production uses separate Supabase, Stripe live, Twilio, Resend, Sentry, and OpenAI credentials/resources from development/test; no production credential exists in Development or a developer shell.
- [ ] Production/Preview secrets are marked Sensitive in Vercel where supported; access is project-scoped, not unnecessarily team-shared.
- [ ] `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=false` in production; `APP_BASE_URL` is the production origin; webhook endpoints use signed production secrets.
- [ ] `CRON_SECRET`, `AUTH_RATE_LIMIT_SALT`, `INTAKE_RATE_LIMIT_SALT`, and `BILLING_RECONCILIATION_SECRET` are distinct production secrets, not reused provider keys.
- [ ] `LEADS_PASSWORD`, `LEADS_COOKIE_SECRET`, expired tokens, unused API keys, old webhook secrets, and stale local exports are absent after an authorized obsolete-secret review.
- [ ] `npm run security:check`, `npm test`, `npm run typecheck`, and `npm run build` pass for the approved release.

## Recovery and monitoring

- [ ] Supabase plan, backup type, retention, earliest/latest recovery points, region, and latest successful backup are recorded.
- [ ] Off-site logical backup policy is recorded; Supabase Storage objects are separately inventoried because database backups do not restore object contents.
- [ ] RPO: __________  RTO: __________  approved by: __________
- [ ] A restore-to-new-project drill passed within the last 90 days on __________; observed data loss: __________; observed recovery time: __________.
- [ ] The restored environment passed schema checks, tenant-isolation spot checks, `verify:account`, `verify:billing` (test/sandbox only), and application smoke tests without sending customer messages or charges.
- [ ] Admin alerts, Sentry delivery, Operations Monitoring, Vercel cron check-ins, and provider webhook diagnostics have a named on-call owner.
- [ ] Platform audit retention/review is assigned; account workspace and cross-account monitoring reads produce `platform_audit_events`.
- [ ] Twilio single-account/subaccount decision is documented and still matches the code architecture.

## Explicit first-super-admin bootstrap

Skip this section when an active super admin already exists; use `/ops/team` for normal invites. Running this SQL **changes production access and requires explicit authorization**. In the Supabase SQL Editor, the authorized owner replaces `APPROVED_OWNER_EMAIL` locally, confirms exactly one matching Auth user, then runs the transaction. Do not commit the filled query.

```sql
begin;

select id, lower(email) as email
from auth.users
where lower(email) = lower('APPROVED_OWNER_EMAIL');

insert into public.platform_operators (user_id, email, role, status)
select id, lower(email), 'super_admin', 'active'
from auth.users
where lower(email) = lower('APPROVED_OWNER_EMAIL')
on conflict (user_id) do nothing;

select email, role, status, created_at
from public.platform_operators
where lower(email) = lower('APPROVED_OWNER_EMAIL');

commit;
```

Success requires one preflight Auth row, one active `super_admin` result, approved ticket evidence, successful `/ops/team` login, and a second owner confirming the roster. If any count is not exactly one, `rollback;` and investigate.

**Decision:** [ ] Approved for production  [ ] Blocked

**Open exceptions, owners, and due dates:** ________________________________________________
