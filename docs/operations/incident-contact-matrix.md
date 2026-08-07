# Production incident contact and ownership matrix

Store contact details in the owner-controlled incident system or password manager, not in this repository. This file records roles and decision rights only. Complete every blank before production launch and test the contact tree quarterly.

## Incident command

| Responsibility | Primary named owner | Backup named owner | Contact-record link | Decision rights |
|---|---|---|---|---|
| Business owner / accountable executive | __________ | __________ | __________ | Customer/business risk, emergency spend, final external statements |
| Incident commander | __________ | __________ | __________ | Severity, coordination, timeline, handoffs, closure |
| Technical lead | __________ | __________ | __________ | Diagnosis, containment/recovery plan, deployment recommendation |
| Security/privacy lead | __________ | __________ | __________ | Access containment, evidence, breach/privacy assessment, counsel escalation |
| Customer communications | __________ | __________ | __________ | Affected-customer notices and update cadence |
| Billing/finance | __________ | __________ | __________ | Stripe, refunds/disputes, spend/fraud, billing communication |
| Evidence recorder | __________ | __________ | __________ | UTC timeline, IDs, approvals, audit/evidence retention |

No person should simultaneously approve and independently verify their own destructive recovery action. When the company has only one operator, name an external backup/owner for authorization and verification.

## Service ownership and escalation

| Service/domain | Internal primary | Internal backup | Provider support/account owner | What the owner controls | Escalate when |
|---|---|---|---|---|---|
| Relay application / Vercel | __________ | __________ | __________ | Deployments, domains, environment names/scopes, logs, cron | Production unavailable, bad deploy, environment exposure, cron stale |
| Supabase database/Auth/Storage | __________ | __________ | __________ | Data, Auth, RLS, backups, recovery project, Storage objects | Data loss/corruption, auth outage, tenant-isolation concern, backup lag |
| Twilio voice/SMS/A2P | __________ | __________ | __________ | Numbers, webhooks, messages, calls, recordings, credentials, fraud/spend | Missed-call loss, duplicate/unauthorized SMS, invalid signature spike, number/A2P issue |
| Stripe billing | __________ | __________ | __________ | Customers, subscriptions, payments, disputes, webhooks, keys | Duplicate/incorrect charge, webhook failure, key exposure, payout/account risk |
| GitHub/source control | __________ | __________ | __________ | Repository, collaborators, branches, Actions/integrations | Unauthorized access/change, source/secret exposure, lost owner access |
| Sentry | __________ | __________ | __________ | Error telemetry, releases, source maps, alerting, auth tokens | Error visibility lost, telemetry exposure, alert failure |
| Resend/email delivery | __________ | __________ | __________ | Sending keys, domains/DNS, logs, suppression/delivery | Alerts/invites fail, unauthorized send, domain compromise |
| Admin email / identity provider | __________ | __________ | __________ | Admin identities, MFA, mailbox, recovery, audit/sign-in logs | Admin takeover, recovery failure, suspicious forwarding/OAuth/session |
| OpenAI voicemail processing | __________ | __________ | __________ | Project/key, usage/budget, transcription/summary processing | Credential/spend anomaly, transcription outage, data-handling incident |
| DNS/domain registrar | __________ | __________ | __________ | Domain, nameservers, DNSSEC, recovery contacts | Domain/DNS change, certificate/routing failure, registrar takeover |
| Legal/privacy/cyber insurance | __________ | __________ | __________ | Notification advice, privilege, regulatory/insurance process | Suspected personal-data breach, extortion, material outage/loss |

## Severity and contact targets

| Severity | Example | Acknowledge | Owner/business update | Provider/customer escalation |
|---|---|---|---|---|
| SEV-1 | Confirmed unauthorized production access; cross-tenant exposure; destructive data loss; widespread missed calls/messages; unauthorized charges | 15 minutes | 30 minutes, then every 30 minutes | Provider immediately; legal/privacy and affected customers per approved assessment |
| SEV-2 | One customer’s critical call/SMS/billing flow unavailable; backup outside RPO; major monitoring gap | 30 minutes | 60 minutes, then hourly | Provider after initial scope/containment; customer with impact/workaround |
| SEV-3 | Degraded noncritical function, contained alert failure, recoverable single event | 4 business hours | Daily until resolved | Provider/customer as impact requires |
| SEV-4 | Question, low-risk defect, planned control improvement | 1 business day | Normal work tracking | Usually none |

The incident commander may raise severity at any time. Never lower severity merely because the cause is unknown.

## Authority matrix

| Action | Proposer | Required approver | Independent verifier | Notes |
|---|---|---|---|---|
| Disable customer automatic texting | Technical/on-call | Incident commander or business owner | Second operator | Record account, reason, time, and customer workaround |
| Deploy emergency application fix | Technical lead | Incident commander | Second operator | Preserve known-good rollback |
| Rotate/revoke production credential | Security/technical lead | Credential owner | Second owner/operator | Follow key-rotation runbook |
| Remove/revoke production administrator | Security/business owner | Business owner or alternate super admin | Second owner | Follow offboarding checklist |
| Restore/clone database | Technical lead | Business owner + database owner | Independent verifier | Follow backup-and-restore drill; production overwrite needs a separate plan |
| Replay provider event | Technical lead | Incident commander | Domain owner | Only original idempotent ID; never blindly retry ambiguous SMS/payment |
| Refund/cancel/transfer number | Billing/Twilio owner | Business owner | Second owner | Execute in authoritative provider, not by editing Relay state |
| Customer notification | Customer communications | Incident commander + privacy/legal when applicable | Evidence recorder | Plain language; no provider codes, credentials, or other tenant data |
| Public/regulatory/insurer notice | Business/security lead | Business owner + counsel | Evidence recorder | Follow applicable deadlines and policy |

## Quarterly contact test

- [ ] Every primary and backup acknowledged a test message through the out-of-band contact method.
- [ ] Provider support plan/account number location is known without exposing it here.
- [ ] Two owners can reach Vercel, Supabase, Twilio, Stripe, GitHub, Sentry, Resend, and admin email with MFA.
- [ ] Emergency/recovery methods are accessible and no longer assigned to departed staff.
- [ ] Severity targets and authority matrix were reviewed.
- [ ] Test date, acknowledgements, failures, and remediation ticket are retained outside Git.

**Last tested:** __________  **Tester:** __________  **Next test:** __________
