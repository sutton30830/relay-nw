# Operator offboarding checklist

Use for employees, contractors, advisors, vendors, role changes, and lost/compromised operator devices. An involuntary or suspected-compromise departure is immediate; a routine planned departure should be scheduled for the person’s last working minute. One owner executes and a second verifies.

**Person:** __________  **Effective UTC:** __________  **Type:** planned / immediate / compromise

**Executor:** __________  **Verifier:** __________  **Ticket:** __________

## Before effective time, when safe

- [ ] Assign every open incident, customer, billing, A2P, support, and deployment responsibility to a named successor.
- [ ] Inventory the person’s Relay role, customer memberships, provider/team roles, GitHub access, devices, API/PAT/SSH/GPG keys, OAuth apps, CLI sessions, shared vault items, recovery materials, and owned automation.
- [ ] Identify credentials they created, revealed, downloaded, copied, or could retrieve; schedule risk-based rotation using the key-rotation runbook.
- [ ] Preserve required business records without copying customer content into the offboarding ticket.
- [ ] For involuntary/compromise cases, skip advance notice and begin containment immediately.

## Revoke at the effective time

- [ ] Relay `/ops/team`: set the operator to `revoked`. Confirm the final-super-admin guard leaves at least one active, tested super admin.
- [ ] Supabase SQL Editor: review `platform_operator_invites` for the person’s email. Revoke any `pending` invite so it cannot later auto-claim. This is a production access change and requires ticket authorization:

```sql
update public.platform_operator_invites
set status = 'revoked'
where lower(email) = lower('DEPARTING_OPERATOR_EMAIL')
  and status = 'pending';
```

- [ ] Remove any customer `account_users` membership that is no longer justified. Relay operator revocation does not automatically remove customer-account access.
- [ ] Supabase Auth: revoke active sessions/refresh tokens or disable/delete the user as approved. A `platform_operators` revoke is checked on the next request, but session revocation is still required for other memberships.
- [ ] Vercel: remove team/project membership, tokens, integrations, deploy hooks, shared environment access, and CLI access; confirm no project/team ownership is stranded.
- [ ] Supabase organization/project: remove membership, personal access tokens, database credentials, CLI tokens, and owned integrations; transfer ownership first.
- [ ] Twilio organization/account/subaccounts: remove account assignments and managed/independent user access; revoke personal API keys/OAuth grants; transfer alert/billing ownership.
- [ ] Stripe organization/accounts: remove team membership and owned roles; revoke personal access; review Security history for the event.
- [ ] GitHub: remove collaborator/organization/team access, PATs, deploy keys, SSH/GPG keys where organizationally managed, Actions/environment approvals, and app installations; transfer repository/admin ownership.
- [ ] Sentry: remove organization/team membership and personal auth tokens; transfer issue/project ownership and alert recipients.
- [ ] Resend: remove team membership and personal/owned API keys; transfer domain, webhook, and billing responsibility.
- [ ] Admin email/identity provider: block sign-in, revoke sessions, remove admin roles, app passwords, OAuth grants, forwarding/delegation, recovery methods, and enrolled devices; preserve mailbox/data per policy.
- [ ] Password manager, domain/DNS, registrar, banking/billing, support accounts, Slack/Teams, calendar, cloud storage, and incident tools: remove access or document N/A.
- [ ] Recover company devices, hardware security keys, phones/SIMs, backup codes, and local repository copies; remote-wipe only under authorized device policy.

## Rotate and verify

- [ ] Rotate every shared or retrievable production credential using the key-rotation runbook. Do not rotate blindly; identify consumers and use successor-first deployment.
- [ ] Review provider logs from 30 days before notice through 24 hours after revocation for unusual login, export, key reveal/create, environment decrypt, role change, webhook, refund, number transfer, or deletion activity.
- [ ] Confirm the person cannot access `/ops`, customer accounts, Vercel, Supabase, Twilio, Stripe, GitHub, Sentry, Resend, or admin email from a fresh private session.
- [ ] Confirm production remains healthy: deployment, login, account read, monitoring, signed webhooks, cron check-ins, alerts, and billing reconciliation.
- [ ] `platform_audit_events` contains the Relay revocation with actor, target, action, and timestamp. Retain provider access-removal/audit events outside Git.
- [ ] Secrets inventory owners, production contact matrix, on-call routing, and recovery custodians are updated.
- [ ] Pending invitations and dormant/service accounts are reviewed; no unexplained access remains.

## Completion evidence

| Evidence | Link / record ID (no secrets) | Verified by |
|---|---|---|
| Relay revoke event | __________ | __________ |
| Provider member removals | __________ | __________ |
| Session/token revocations | __________ | __________ |
| Required rotations | __________ | __________ |
| Log review | __________ | __________ |
| Fresh-session denial test | __________ | __________ |
| Production health check | __________ | __________ |

**Status:** [ ] Complete  [ ] Exception open

**Exception, owner, due date:** ________________________________________________
