# Operational security and disaster-recovery readiness

**Audit date:** 2026-08-06

**Scope:** repository evidence only; no provider account, credential, access, backup, or restore state was changed.

**Owner:** Relay NW production owner (name to be entered in the contact matrix).

**Review cadence:** quarterly and after every incident, operator departure, provider migration, or material architecture change.

Use these status labels consistently:

- **VERIFIED — REPOSITORY:** demonstrated by committed code, schema, tests, or Git metadata.
- **OWNER CONFIRMATION — EXTERNAL:** can only be established in a provider console, identity provider, billing record, or password manager.
- **TEST REQUIRED:** a documented procedure exists but Relay NW has no retained evidence of a successful controlled exercise.

Never store credentials, recovery codes, backup contents, or screenshots containing secret values in this repository. Store evidence in the owner-controlled security folder named in the incident matrix. A useful evidence filename is `YYYY-MM-DD_provider_control_reviewer`, with a ticket or document link recorded in the inventory.

## Executive readiness result

Relay NW has meaningful application-layer security controls, but disaster recovery is **not yet demonstrated**. Production readiness remains conditional on the owner completing the external access/MFA review, proving development and production credential separation, confirming Supabase backup coverage, and completing an authorized restore-to-new-project drill.

| Control | Status | Repository evidence / remaining work |
|---|---|---|
| Secrets excluded from Git | **VERIFIED — REPOSITORY** | `.env`, `.env.local`, `.env.sentry-build-plugin`, and `.vercel` are ignored; `git ls-files '.env*'` returns only `.env.example`. `npm run security:check` enforces this. |
| Placeholder-only committed environment file | **VERIFIED — REPOSITORY** | `.env.example` contains names and placeholders; the security check rejects common credential-shaped values. |
| Server-only privileged credentials | **VERIFIED — REPOSITORY** | `lib/env.ts` is marked `server-only`; Twilio auth, Stripe secret/webhook secret, Supabase service role, Resend, OpenAI, cron, and rate-limit secrets are consumed server-side. Public Supabase anon and Sentry DSN values are intentionally public configuration, not privileged secrets. |
| Signed provider webhooks | **VERIFIED — REPOSITORY** | Twilio and Stripe routes validate provider signatures; production startup rejects `ALLOW_UNSIGNED_TWILIO_WEBHOOKS=true`. Tests cover both boundaries. |
| Production Operations authorization | **VERIFIED — REPOSITORY** | `platform_operators` is separate from customer membership, has `super_admin`/`operator`/`support` roles and active/revoked states, fails closed for revoked users, prevents removal of the final active super admin, and exposes an operator inventory at `/ops/team`. |
| No identity-specific implicit admin grant | **VERIFIED — REPOSITORY** | Current schema/setup SQL contains no named-user bootstrap. Reapplying schema cannot silently restore a revoked operator. First-admin bootstrap is an explicit, owner-authorized procedure. |
| Sensitive support auditing | **VERIFIED — REPOSITORY, PARTIAL SCOPE** | Platform/account audit tables are server-only under RLS. Account workspace reads, cross-account monitoring reads, exports, operator changes, commercial exceptions, and many support mutations write actor/action/target/timestamp evidence. Sensitive reads fail closed if their audit insert fails. Directory/work-queue reads and some best-effort mutation audit paths are not independently guaranteed; provider-console activity depends on provider logs. |
| Tenant isolation | **VERIFIED — REPOSITORY** | Account-scoped tables require `account_id`; direct anon/authenticated client access is denied; adversarial and tenant-contract tests cover isolation. |
| Separate development and production credentials | **OWNER CONFIRMATION — EXTERNAL** | Vercel supports Production, Preview, and Development scopes, but the repository cannot prove distinct provider projects/accounts/keys or their current scope. Complete the access checklist and secrets inventory. |
| MFA on Vercel, Supabase, Twilio, Stripe, GitHub, Sentry, Resend, admin email | **OWNER CONFIRMATION — EXTERNAL** | No repository artifact can prove current enrollment, enforcement, recovery method custody, or member coverage. Complete the provider-by-provider evidence table below. |
| Supabase database backups | **OWNER CONFIRMATION — EXTERNAL** | Plan, backup type, retention window, latest successful recovery point, and Storage-object coverage are not in the repository. |
| Restore drill | **TEST REQUIRED** | No dated drill record, observed RPO/RTO, restored row counts, or application verification evidence exists. Follow the backup-and-restore drill only after explicit authorization. |
| Key rotation | **TEST REQUIRED** | Rotation variables and procedures are documented, but no retained drill/rotation evidence is present. Do not rotate as part of a review. |
| Obsolete secret removal | **OWNER CONFIRMATION — EXTERNAL** | `LEADS_PASSWORD` exists by name in the ignored local environment but has no runtime code reference; `LEADS_COOKIE_SECRET` also belongs to the retired shared-password gate. Confirm no rollback needs them, then remove/revoke them from every provider/environment under an authorized ticket. No value was inspected or committed. |
| Operator offboarding | **TEST REQUIRED** | Relay-side revocation and last-super-admin protection exist, but the complete cross-provider departure workflow has no retained test evidence. |

## Required MFA and administrator evidence

Do not enable enforcement or remove a user during an audit without explicit authorization. First inventory members, notify affected users, confirm two recovery-capable owners, and retain before/after evidence.

| Provider | Owner confirmation steps | Evidence to retain outside Git |
|---|---|---|
| Vercel | Team Settings → **Security & Privacy** → confirm Two-Factor Authentication Enforcement is on; Team Settings → **Members** → filter for disabled 2FA; review owners and project roles. | Dated enforcement screenshot, member export/list showing role and 2FA status, two recovery-capable owners, recovery-code custody attestation. [Vercel 2FA enforcement](https://vercel.com/docs/two-factor-enforcement) |
| Supabase | Organization → **Security** → confirm “Require MFA to access organization”; Organization → **Team** → export/review members, roles, project scope, and `mfa_enabled`. On plans without enforcement, verify every member individually. | Dated security setting, member list/API response with values redacted except identity/role/MFA status, two owner attestations. [Supabase organization MFA](https://supabase.com/docs/guides/platform/mfa/org-mfa-enforcement) |
| Twilio | Admin/User management → inventory managed and independent users, account assignments, and roles; Account Settings/General Settings → confirm account 2FA requirement; each user → Personal Settings → Security → confirm authenticator/passkey-capable method and recovery-code custody. | Dated user/role export, account-level requirement screenshot, owner recovery attestation. Paid accounts requiring 2FA does not replace this review. [Twilio managed users](https://www.twilio.com/docs/iam/organizations/managed-users) |
| Stripe | Organization or account → **Team** → confirm “Require two-step authentication for all team members”; review least-privilege roles; **Security history** → retain the enforcement/member review event/export. | Team/role list, 2FA enforcement screenshot, security-history export, two administrator owners. [Stripe team access](https://docs.stripe.com/get-started/account/orgs/team) |
| GitHub | This repository’s configured remote is a personal namespace, so organization-wide enforcement is not repository-verifiable. Personal Settings → **Password and authentication** → confirm secure 2FA and recovery methods; repository Settings → **Collaborators** → inventory access. If transferred to an organization, Organization Settings → Authentication security → require secure 2FA methods. | Personal 2FA attestation without recovery codes, collaborator list, owner/admin list, organization enforcement screenshot if applicable. [GitHub organization 2FA](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization) |
| Sentry | Organization Settings → **Auth/Security** → confirm Require 2FA (or SSO with IdP MFA); Members → review owner/manager/member roles and 2FA state before enabling enforcement because non-enrolled members may be removed. | Before/after member list, auth setting, owner list, audit-log/export if plan supports it. [Sentry enforcement behavior](https://sentry.zendesk.com/hc/en-us/articles/26940068383259-We-cannot-access-Sentry-after-enforcing-2FA-is-this-intended-behaviour) |
| Resend | Profile → **Enable MFA** for each administrator; Team Settings → review the list of members with/without MFA. If team-level enforcement is available in the current plan/UI, document it; otherwise require and attest member-by-member MFA. | Dated member/MFA list, role list, two admin owners, recovery attestation. Never capture QR seeds or codes. [Resend MFA](https://resend.com/changelog/multi-factor-authentication) |
| Admin email | Identify the actual provider. For Google Workspace, Admin console → Security → Authentication → 2-Step Verification and Directory → Users → Admin roles; require strong 2SV for all admins. For Microsoft 365, Entra admin center → Protection → Conditional Access (or Security Defaults), Roles and administrators, and Sign-in logs; require phishing-resistant MFA for privileged roles and maintain monitored emergency access. | Provider name/tenant, admin-role export, MFA policy and coverage report, recovery/emergency account owners, dated sign-in test. [Google Workspace 2SV](https://support.google.com/a/answer/175197), [Microsoft privileged access](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/security-planning) |

## Twilio main account versus subaccount decision

**Current repository constraint:** Relay uses one global `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, a singleton client, and globally unique provider SIDs. The current code is therefore a **single-account design**. Do not move a customer to a subaccount until account-specific credential selection and account-scoped SID resolution are implemented and tested.

Stay on one Twilio account for the small pilot only when all of these are true:

- one Relay operations team administers every customer;
- shared billing, spend controls, A2P operations, and provider visibility are acceptable;
- per-customer credential revocation and console isolation are not contractual requirements;
- the small blast radius is explicitly accepted and monitored;
- a documented migration trigger and owner exist.

Choose one subaccount per customer before onboarding the customer when any of these is true:

- a customer needs data/resource isolation, delegated provider access, separate usage reporting, or independent credential revocation;
- a contractual, privacy, reseller/ISV, regional, or compliance requirement calls for provider-level separation;
- customer-specific fraud/spend containment or closure is required;
- operations volume makes accidental cross-customer number, message, or recording access materially likely.

Subaccounts isolate resources and credentials, but they still share the parent balance and parent-account suspension risk, and parent credentials can reach many subaccount resources. Before migrating, add an account-level Twilio account SID and credential reference, instantiate clients per account, scope every call/message/recording resolver by account SID, update webhook validation for the correct auth secret, backfill data, test all callback/recovery paths, and plan number/A2P/Messaging Service movement. [Twilio subaccounts](https://www.twilio.com/docs/iam/api/subaccounts)

## Package contents

1. [Production-access checklist](production-access-checklist.md)
2. [Key-rotation runbook](key-rotation-runbook.md)
3. [Backup-and-restore drill](backup-restore-drill.md)
4. [Operator offboarding checklist](operator-offboarding-checklist.md)
5. [Production incident contact/ownership matrix](incident-contact-matrix.md)
6. [Secrets inventory template](secrets-inventory-template.md)

Run the repository enforcement check with:

```bash
npm run security:check
```

This check does not inspect or validate secret values and does not contact a live service.
