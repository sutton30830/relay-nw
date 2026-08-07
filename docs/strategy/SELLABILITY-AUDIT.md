# Relay NW — Sellability Audit

**Date:** May 17, 2026
**Question asked:** Can I sell this app to paying customers as it stands today?
**Short answer:** Yes, to **one customer at a time as a hand-provisioned service**. No, **not as a self-serve SaaS**. The gap between those two is real but bridgeable in weeks, not months.

---

## What you've actually built

A missed-call → SMS-back + voicemail-capture tool for a single home-services business. A call comes into a forwarded line or directly to a Twilio number, your app catches the miss, drops the lead into Supabase, fires one SMS to the caller with an intake/booking link, records and transcribes the voicemail with OpenAI, and surfaces everything in a password-gated `/leads` inbox optimized for a phone-in-the-truck contractor. Your own README is admirably honest: *"intentionally single-business. No accounts, billing, CRM, shared inbox, business-hours logic, or multi-tenant support."*

That single line is the entire sellability story.

## What's working — and working well

The core loop is wired end-to-end with real production engineering, not prototype-grade code:

- Twilio signature validation is correctly implemented across every webhook (voice, sms, recording, dial-status, voice-status, sms-status) against multiple candidate URLs, with safe production overrides
- Missed-call idempotency keyed on `CallSid`; inbound-SMS dedupe keyed on `MessageSid`
- SMS cooldown and STOP/HELP opt-out handling
- Voicemail transcription kicked off via Next.js `after()` so the Twilio response stays fast
- The `/leads` inbox is genuinely well-designed for mobile: large tap targets, `tel:` / `sms:` deep links, voicemail audio playback, AI summary, priority badges, ⌘K search, sample-data toggle for demos, auto-refresh
- Lead drawer with notes, priority override, booked-value tracking, trash/restore
- Privacy and Terms pages exist with SMS consent and opt-out language — enough substance to survive A2P 10DLC review
- Sentry is wired (initializes when `SENTRY_DSN` is set)
- Rate limiting on `/api/intake` (5/hr/IP) and `/api/leads-login` (8/15min/IP) — in-memory, fine for low volume
- Zero `TODO` / `FIXME` / `HACK` comments anywhere

This is competent solo work. The `/leads` surface in particular looks and feels like a product.

## What blocks revenue

These are the things that prevent you from charging a stranger today.

**1. No billing infrastructure at all.** Zero matches for stripe, paddle, lemonsqueezy, checkout, subscription, invoice. The landing page advertises "$99/month, no contracts, 30-day refund" but the only CTA is "Start setup," which goes to a contact form. You cannot accept a credit card in-app.

**2. No real auth, no concept of a user/account.** Authentication is one shared password signed into an HMAC cookie (`lib/leads-auth.ts`). The `Lead` type has no `user_id` / `account_id` / `tenant_id` — zero matches in the codebase. `getLeads()` is effectively `select * from leads`. This is not a multi-tenant SaaS; it is a templated single-tenant app, one Vercel project per customer.

**3. No self-serve onboarding.** Per your own `docs/customer-setup.md`, every new customer requires you to collect their info, hand-edit Vercel env vars (`BUSINESS_NAME`, `OWNER_PHONE_NUMBER`, `TWILIO_PHONE_NUMBER`, `LEADS_PASSWORD`), redeploy, configure Twilio webhooks, walk them through carrier-forwarding `*72` codes, and run a manual test call. The "intake form" on the site is a sales-contact form that drops a row into the same `leads` table the owner uses — which means a marketing inquiry shows up next to actual customer leads.

**4. No outbound email.** No Resend / Postmark / SendGrid. No welcome email, no receipt, no password reset, no weekly digest, no "you missed an SMS" alert. The only owner notification is a Twilio SMS.

**5. No settings UI.** Business name, away-message copy, cooldown, owner phone — all of these live in Vercel env vars. A customer cannot change anything without you redeploying.

**6. The `/sms-consent` page is a dead form.** It calls `setSubmitted(true)` and posts to nothing. Ship a real form or remove the page; a fake submit is a credibility risk and potentially an A2P-review risk.

## Security & compliance — what to fix before going live

- **Verified:** `.env.local` is correctly gitignored and was never committed. No secret leak via the repo. (The original draft of this audit overstated this — flagging it because secrets handling is the kind of thing that gets misremembered.)
- **Historical note:** `LEADS_PASSWORD` and `LEADS_COOKIE_SECRET` belonged to the retired shared-password gate and are not runtime inputs now. Remove them from local/Vercel environments after confirming no rollback deployment uses them. Current production credentials, including `SUPABASE_SERVICE_ROLE_KEY`, must be unique per environment.
- **RLS posture:** every Supabase table has RLS enabled with no policies. Correct given service-role-only writes — but it means leaking the service key is total compromise, so guard it accordingly.
- **Authorization model:** any user with the shared password sees every lead. With one customer this is fine. The instant you put two customers on one instance, customer A reads customer B's leads. Hard wall against multi-tenancy on the current schema.
- **Toll fraud:** legacy automated call and SMS diagnostics were removed from the customer surface. Keep any future diagnostic tooling tightly scoped to the authenticated account.
- **A2P 10DLC:** complete this before charging a customer. Without it, US carriers throttle or block your outbound SMS, which **is the entire product.** Your README knows this; treat it as a launch blocker.

## Polish & presentation

The landing page reads like a real product — clean phone mockup, three-step explainer, pricing headline, refund promise. The intake form has a honeypot, US-phone formatting, validation, and consent checkbox. The `/leads` inbox is the strongest asset.

What it's missing on the surface: a settings screen, an analytics/lifetime-leads view, a first-run wizard ("here's your number, here's your forwarding code, here's your test call"). None of these are blockers; all of them would raise perceived professionalism.

## Verdict & timeline

**Sell today (this week):** Yes, manually. White-glove provision 1–3 friendly local businesses. Invoice via Stripe Payment Link or ACH. Charge $99–$199/mo. Your own `docs/production-readiness.md` says exactly this, and it is correct. You earn revenue and learn what breaks in the wild. The risk you take on is operational, not product: every customer is a manual deploy and a manual support burden.

**Sell at 3–10 customers (2–4 weeks of focused work):** Achievable without rewriting the data model if you:
1. Build a per-customer template repo / Vercel project generator
2. Wire Stripe Payment Links + a manual reconciliation process
3. Complete A2P 10DLC
4. Fix the `/sms-consent` form
5. Add a real owner-notification email channel

You're still a service business, but a defensible one with predictable economics.

**Sell as self-serve SaaS at 10–50+ customers (2–3 months):** Requires the bigger rewrite — `account_id` on every table, a Twilio-To-number → account lookup at every webhook ingress, Supabase Auth (magic-link or email/password), self-service Twilio number purchase via the Twilio API during signup, a settings page, real billing with Stripe Checkout + subscriptions. The data-model migration alone is 2–3 weeks; doing it carefully (with backfill + dual-read) is the difference between "still alive at customer #20" and "rewrite again at customer #20."

## Punch list — do these before charging anyone

| # | Item | Why | Effort |
|---|------|-----|--------|
| 1 | Complete Twilio A2P 10DLC registration | Without it, US SMS gets throttled/blocked — the entire product breaks | Days of waiting + a form |
| 2 | Remove retired `LEADS_PASSWORD` / `LEADS_COOKIE_SECRET` values and confirm current credentials such as `SUPABASE_SERVICE_ROLE_KEY` are unique per environment | Retired or reused credentials increase exposure | 1 hour |
| 3 | Wire a way to collect money — Stripe Payment Link is fine for v1 | You advertise $99/mo on the landing page; you currently have no way to charge it | 2 hours |
| 4 | Fix or delete `/sms-consent` (dead form) | Shipping a non-functional consent form is a credibility + compliance risk | 30 min |
| 5 | Run the `docs/customer-setup.md` checklist end-to-end against a live carrier-forwarded line | Forwarding-mode caller-ID and hang-up timing are the highest-risk real-world quirks | 2 hours |

## Punch list — would raise the ceiling, not blockers

| # | Item | Why |
|---|------|-----|
| 1 | Add `account_id` to schema; route webhooks by `To` number → account | Unlocks one Vercel project for all customers |
| 2 | Self-serve Twilio number purchase via API during signup | Removes 80% of manual onboarding |
| 3 | Replace shared-password cookie with Supabase Auth | Real users, real password resets, real audit trail |
| 4 | Settings page (business name, SMS template, owner phone, cooldown) | Get config out of env vars, let customers self-edit |
| 5 | Resend-powered transactional email (welcome, receipt, weekly digest, missed-SMS alert) | Cheap to add, big professionalism lift |

## Bottom line

You've built a focused, well-engineered, well-designed single-tenant utility. The core loop genuinely works. The thing standing between you and revenue is not the product — it's the absence of billing, signup, and multi-tenancy. Treat your first 1–3 customers as paid pilots that you onboard by hand, charge with Stripe Payment Links, and learn from. Use the revenue and the learning to fund the multi-tenant rewrite. Don't ship the rewrite before you have paying customers — the customers will tell you which parts of the rewrite actually matter.

The list at the end of your README under "Not In V1" — billing, user accounts, multi-business support — is exactly the list of what must exist for this to be a product rather than a service. You already know what to do.
