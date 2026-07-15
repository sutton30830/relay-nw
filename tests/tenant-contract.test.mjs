import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase.sql", import.meta.url), "utf8");
const envTs = await readFile(new URL("../lib/env.ts", import.meta.url), "utf8");
const twilioTs = await readFile(new URL("../lib/twilio.ts", import.meta.url), "utf8");
const twimlTs = await readFile(new URL("../lib/twiml.ts", import.meta.url), "utf8");
const authTs = await readFile(new URL("../lib/auth.ts", import.meta.url), "utf8");
const emailTs = await readFile(new URL("../lib/email.ts", import.meta.url), "utf8");
const missedCallTs = await readFile(new URL("../lib/missed-call.ts", import.meta.url), "utf8");
const intakeRouteTs = await readFile(new URL("../app/api/intake/route.ts", import.meta.url), "utf8");
const authLoginRouteTs = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
const authPasswordLoginRouteTs = await readFile(new URL("../app/api/auth/password-login/route.ts", import.meta.url), "utf8");
const authPasswordResetRouteTs = await readFile(new URL("../app/api/auth/password-reset/route.ts", import.meta.url), "utf8");
const authSelectAccountRouteTs = await readFile(new URL("../app/api/auth/select-account/route.ts", import.meta.url), "utf8");
const authUpdatePasswordRouteTs = await readFile(new URL("../app/api/auth/update-password/route.ts", import.meta.url), "utf8");
const authCallbackRouteTs = await readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8");
const inboundSmsRouteTs = await readFile(new URL("../app/api/twilio/sms/route.ts", import.meta.url), "utf8");
const homePageTsx = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const loginPageTsx = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
const accountSelectPageTsx = await readFile(new URL("../app/account/select/page.tsx", import.meta.url), "utf8");
const accountPasswordPageTsx = await readFile(new URL("../app/account/password/page.tsx", import.meta.url), "utf8");
const intakeFormTsx = await readFile(new URL("../app/intake/intake-form.tsx", import.meta.url), "utf8");
const leadsPageTsx = await readFile(new URL("../app/leads/page.tsx", import.meta.url), "utf8");
const leadsListTsx = await readFile(new URL("../app/leads/leads-list.tsx", import.meta.url), "utf8");
const setupPageTsx = await readFile(new URL("../app/setup/page.tsx", import.meta.url), "utf8");
const settingsPageTsx = await readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
const reportsPageTsx = await readFile(new URL("../app/reports/page.tsx", import.meta.url), "utf8");
const leadConversationPageTsx = await readFile(new URL("../app/leads/[id]/page.tsx", import.meta.url), "utf8");
const appHeaderTsx = await readFile(new URL("../app/leads/_components/app-header.tsx", import.meta.url), "utf8");
const leadUtilsTs = await readFile(new URL("../app/leads/_utils.ts", import.meta.url), "utf8");
const leadConstantsTs = await readFile(new URL("../app/leads/_constants.ts", import.meta.url), "utf8");
const leadCardTsx = await readFile(new URL("../app/leads/_components/lead-card.tsx", import.meta.url), "utf8");
const leadDrawerTsx = await readFile(new URL("../app/leads/_components/lead-drawer.tsx", import.meta.url), "utf8");
const setupRequestDetailsTsx = await readFile(new URL("../app/leads/_components/setup-request-details.tsx", import.meta.url), "utf8");
const globalsCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const opsPageTsx = await readFile(new URL("../app/ops/page.tsx", import.meta.url), "utf8");
const opsRunbookPageTsx = await readFile(new URL("../app/ops/runbook/page.tsx", import.meta.url), "utf8");
const opsSetupRequestsPageTsx = await readFile(new URL("../app/ops/setup-requests/page.tsx", import.meta.url), "utf8");
const opsToolbarTsx = await readFile(new URL("../app/ops/_components/ops-toolbar.tsx", import.meta.url), "utf8");
const opsSetupRequestsRouteTs = await readFile(new URL("../app/api/ops/setup-requests/route.ts", import.meta.url), "utf8");
const privacyPageTsx = await readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8");
const termsPageTsx = await readFile(new URL("../app/terms/page.tsx", import.meta.url), "utf8");
const opsRunbookMd = await readFile(new URL("../docs/ops-runbook.md", import.meta.url), "utf8");
const customerSetupMd = await readFile(new URL("../docs/customer-setup.md", import.meta.url), "utf8");
const setupRequestsTs = await readFile(new URL("../lib/supabase/setup-requests.ts", import.meta.url), "utf8");
const middlewareTs = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
const verifyAccountScript = await readFile(new URL("../scripts/verify-account.mjs", import.meta.url), "utf8");
const backfillAccountIdsScript = await readFile(new URL("../scripts/backfill-account-ids.mjs", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("tenant core tables are present", () => {
  for (const table of [
    "public.accounts",
    "public.account_phone_numbers",
    "public.account_users",
    "public.account_settings",
    "public.calls",
    "public.messages",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table.replace(".", "\\.")}`));
  }
});

test("account users can bind Supabase Auth users to accounts", () => {
  assert.match(sql, /alter table public\.account_users add column if not exists user_id uuid/);
  assert.match(sql, /drop index if exists account_users_user_id_unique_idx/);
  assert.match(sql, /account_users_user_id_idx/);
  assert.match(sql, /account_users_account_user_id_unique_idx/);
  assert.match(sql, /account_users_email_idx/);
});

test("account verifier checks pilot provisioning prerequisites", () => {
  assert.match(packageJson, /"verify:account": "node scripts\/verify-account\.mjs"/);
  assert.match(verifyAccountScript, /account_settings/);
  assert.match(verifyAccountScript, /account_phone_numbers/);
  assert.match(verifyAccountScript, /account_users/);
  assert.match(verifyAccountScript, /owner_email is set/);
  assert.match(verifyAccountScript, /operating state: \$\{smsOperatingState\.label\}/);
  assert.match(verifyAccountScript, /Live · Auto-text paused/);
  assert.match(verifyAccountScript, /Twilio number is not a placeholder/);
});

test("email notifications are documented and lazily initialized", () => {
  assert.match(envExample, /RESEND_API_KEY/);
  assert.match(envExample, /ALERT_FROM_EMAIL/);
  assert.match(envExample, /ADMIN_ALERT_EMAIL/);
  assert.match(sql, /owner_email text/);
  assert.match(emailTs, /function getResendClient\(\)/);
  assert.doesNotMatch(emailTs.split("function getResendClient()")[0], /new Resend/);
});

test("privacy and terms disclose recording, transcription, AI processing, and retention", () => {
  assert.match(privacyPageTsx, /voicemail recordings, transcripts, and short summaries/);
  assert.match(privacyPageTsx, /Twilio and OpenAI/);
  assert.match(privacyPageTsx, /does not use voicemail recordings, transcripts, or summaries for\s+advertising/);
  assert.match(privacyPageTsx, /Operational webhook logs and\s+inbound SMS bodies are pruned/);
  assert.match(privacyPageTsx, /delete or export account records/);

  assert.match(termsPageTsx, /voicemail capture, transcription, and SMS\s+follow-up/);
  assert.match(termsPageTsx, /Calls that reach Relay NW voicemail may be recorded, transcribed, and summarized/);
  assert.match(termsPageTsx, /Businesses are responsible/);
});

test("ops runbook is authenticated and covers failure visibility plus retention", () => {
  assert.match(opsToolbarTsx, /href="\/ops\/runbook"/);
  assert.match(opsRunbookPageTsx, /requireAccountUser\(\)/);
  assert.match(opsRunbookPageTsx, /This page is for you, not the owner/);
  assert.match(opsRunbookPageTsx, /Search technical logs by caller last 4, call id, message id, recording id/);
  assert.match(opsRunbookPageTsx, /Auto-text sends only when A2P is approved and texting is on/);
  assert.match(opsRunbookPageTsx, /WEBHOOK_EVENT_RETENTION_DAYS/);
  assert.match(opsRunbookPageTsx, /INBOUND_MESSAGE_RETENTION_DAYS/);
  assert.match(opsRunbookPageTsx, /manual deletion or automated recording retention ships/);

  assert.match(opsRunbookMd, /SMS Failed, Undelivered, or Not Sent/);
  assert.match(opsRunbookMd, /Voicemail or Transcription Failed/);
  assert.match(opsRunbookMd, /Alert Email Not Received/);
  assert.match(opsRunbookMd, /Voicemail recordings, transcripts, and lead records are retained until manually deleted/);
  assert.match(opsRunbookMd, /Backup, Restore, and Deletion/);
});

test("assisted onboarding setup requests are operator-only and status tracked", () => {
  assert.match(authTs, /export function isRelayOperator/);
  assert.match(authTs, /export async function requireRelayOperator\(\)/);
  assert.match(opsToolbarTsx, /href="\/ops\/setup-requests"/);
  assert.match(opsSetupRequestsPageTsx, /requireRelayOperator\(\)/);
  assert.match(opsSetupRequestsPageTsx, /listSetupRequests\(status\)/);
  assert.match(opsSetupRequestsPageTsx, /New/);
  assert.match(opsSetupRequestsPageTsx, /Contacted/);
  assert.match(opsSetupRequestsPageTsx, /Onboarded/);
  assert.match(opsSetupRequestsPageTsx, /Closed/);
  assert.match(opsSetupRequestsRouteTs, /requireRelayOperator\(\)/);
  assert.match(opsSetupRequestsRouteTs, /updateSetupRequestStatus\(id, status\)/);
  assert.match(setupRequestsTs, /export type SetupRequestStatus = "new" \| "contacted" \| "onboarded" \| "closed"/);
  assert.match(setupRequestsTs, /\.from\("setup_requests"\)[\s\S]*\.update\(\{ status \}\)/);
});

test("ops pages share the same internal tool actions", () => {
  assert.match(opsToolbarTsx, /export function OpsToolbar/);
  assert.match(opsToolbarTsx, /href="\/ops"/);
  assert.match(opsToolbarTsx, /href="\/ops\/setup-requests"/);
  assert.match(opsToolbarTsx, /href="\/ops\/runbook"/);
  assert.match(opsToolbarTsx, /action="\/api\/email-test\/start"/);
  assert.match(opsToolbarTsx, /href="\/leads"/);

  for (const source of [opsPageTsx, opsRunbookPageTsx, opsSetupRequestsPageTsx]) {
    assert.match(source, /OpsToolbar/);
  }
});

test("customer setup docs describe current assisted provisioning flow", () => {
  assert.match(customerSetupMd, /\/ops\/setup-requests/);
  assert.match(customerSetupMd, /npm run provision:account/);
  assert.match(customerSetupMd, /npm run verify:account -- <slug>/);
  assert.match(customerSetupMd, /Live · Auto-text paused/);
  assert.match(customerSetupMd, /owner can sign in with email\/password/);
  assert.doesNotMatch(customerSetupMd, /LEADS_PASSWORD|lead inbox password|Vercel production environment variables/);
});

test("missed-call owner notification only follows inserted leads", () => {
  const duplicateReturnIndex = missedCallTs.indexOf('smsStatus: "duplicate"');
  const notifyIndex = missedCallTs.indexOf("notifyOwnerNewMissedCallLead({");
  assert.ok(duplicateReturnIndex > -1);
  assert.ok(notifyIndex > duplicateReturnIndex);
});

test("public intake setup requests go to setup_requests, never a tenant leads inbox", () => {
  assert.match(sql, /create table if not exists public\.setup_requests/);
  assert.match(intakeRouteTs, /createSetupRequest\(\{/);
  assert.doesNotMatch(intakeRouteTs, /createLead\(/);
  // Admin alert stays best-effort after the request is saved.
  assert.match(intakeRouteTs, /notifyAdminNewSetupRequest\(\{/);
  assert.match(intakeRouteTs, /admin notification failed/);
});

test("booked is an outcome flag, never a workflow status button", () => {
  const constantsTs = leadUtilsTs; // countLeads lives in _utils
  assert.match(constantsTs, /booked: visibleLeads\.filter\(isBookedLead\)\.length/);
  // The Booked inbox view is an outcome view: it must filter on isBookedLead
  // (the booked_at flag), never on lead.status, so it works for any status.
  assert.match(constantsTs, /filter === "booked"[\s\S]{0,120}isBookedLead\(lead\)/);
  assert.match(leadConstantsTs, /key: "booked"/);
  assert.match(
    leadConstantsTs,
    /key: "new"[\s\S]*key: "contacted"[\s\S]*key: "dead"[\s\S]*key: "booked"[\s\S]*key: "trash"/,
  );
  // Status buttons stay New/Contacted/Closed — booked is set via the outcome
  // toggle or booked-value input, not by changing workflow status.
  assert.doesNotMatch(leadConstantsTs, /STATUS_OPTIONS: LeadStatus\[\] = \["new", "contacted", "booked", "dead"\]/);
  assert.match(leadCardTsx, /booked \? "Mark as Unbooked" : "Mark as Booked"/);
  assert.match(leadCardTsx, /onBooked\(lead\.id, !booked\)/);
});

test("lead card actions keep workflow controls explicit and avoid duplicate details", () => {
  assert.match(leadCardTsx, /const statusLabel = trashed \? "Trash" : STATUS_LABELS\[lead\.status\]/);
  assert.match(leadCardTsx, /lead-card__status-pill lead-card__status-pill--\$\{statusTone\}/);
  assert.match(leadCardTsx, /trigger=\{<>Status<\/>\}/);
  assert.match(leadCardTsx, /triggerAriaLabel="Change lead status"/);
  assert.doesNotMatch(leadCardTsx, />Details</);
  assert.doesNotMatch(leadCardTsx, /Booked value missing/);
});

test("lead card hides raw sms error codes behind owner-facing language", () => {
  assert.match(leadCardTsx, /function smsAlertText\(error: string \| null\)/);
  assert.match(leadCardTsx, /\\d\{4,6\}/);
  assert.doesNotMatch(leadCardTsx, /Code \$\{normalized\}/);
  assert.doesNotMatch(leadCardTsx, /\{lead\.sms_error \|\| "SMS delivery failed"\} - call them directly/);
});

test("mobile lead cards prioritize category and actionable facts", () => {
  assert.match(leadCardTsx, /lead-card__meta-secondary/);
  assert.match(leadCardTsx, /lead-card__fact--essential/);
  assert.match(leadCardTsx, /lead-card__fact--secondary/);
  assert.match(leadCardTsx, /SMS skipped: opted out/);
  assert.match(globalsCss, /@media \(max-width: 720px\)[\s\S]*\.lead-card__meta-secondary,[\s\S]*\.lead-card__fact--secondary[\s\S]*display:\s*none/);
  assert.match(globalsCss, /@media \(max-width: 720px\)[\s\S]*\.lead-card__status-pill\s*\{[\s\S]*min-height:\s*32px/);
});

test("mobile booked value control stays compact and polished", () => {
  assert.match(leadCardTsx, /<Icon name="star" size=\{13\} \/>/);
  assert.match(globalsCss, /@media \(max-width: 560px\)[\s\S]*\.lead-card__value\s*\{[\s\S]*display:\s*grid/);
  assert.match(globalsCss, /@media \(max-width: 720px\)[\s\S]*\.lead-card__status-pill\s*\{[\s\S]*min-height:\s*32px/);
  assert.match(globalsCss, /@media \(max-width: 560px\)[\s\S]*\.lead-card__value\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  assert.match(globalsCss, /@media \(max-width: 560px\)[\s\S]*\.lead-card__value \.money-field--compact\s*\{[\s\S]*min-height:\s*40px/);
  assert.match(globalsCss, /@media \(max-width: 560px\)[\s\S]*\.lead-card__value \.money-field--compact input\s*\{[\s\S]*font-size:\s*18px/);
});

test("lead inbox empty states distinguish search misses from no leads", () => {
  assert.match(leadsListTsx, /const hasSearch = trimmedQuery\.length > 0/);
  assert.match(leadsListTsx, /accountHasAnyLeads = inbox\.counts\.all \+ inbox\.counts\.trash > 0/);
  assert.match(leadsListTsx, /No leads match/);
  assert.match(leadsListTsx, /this keyword just does not match them/);
  assert.match(leadsListTsx, /No missed calls yet/);
});

test("human-facing pages require authenticated account context", () => {
  assert.match(authTs, /export async function requireAccountUser\(\)/);
  assert.match(authTs, /account_users/);
  assert.match(leadsPageTsx, /requireAccountUser\(\)/);
  assert.match(setupPageTsx, /requireAccountUser\(\)/);
  assert.match(settingsPageTsx, /requireAccountUser\(\)/);
  assert.match(reportsPageTsx, /requireAccountUser\(\)/);
  assert.match(leadConversationPageTsx, /requireAccountUser\(\)/);
  assert.match(opsPageTsx, /requireAccountUser\(\)/);
  assert.doesNotMatch(leadsPageTsx, /getDefaultAccountConfig/);
  assert.doesNotMatch(setupPageTsx, /getDefaultAccountConfig/);
  assert.doesNotMatch(settingsPageTsx, /getDefaultAccountConfig/);
  assert.doesNotMatch(reportsPageTsx, /getDefaultAccountConfig/);
  assert.doesNotMatch(leadConversationPageTsx, /getDefaultAccountConfig/);
  assert.doesNotMatch(opsPageTsx, /getDefaultAccountConfig/);
});

test("authenticated app pages share the Relay brand header and owner menu", () => {
  assert.match(appHeaderTsx, /export function AppHeader/);
  assert.match(appHeaderTsx, /app-head__brand/);
  assert.match(appHeaderTsx, /mobile-owner-menu/);
  assert.match(appHeaderTsx, /\/leads/);
  assert.match(appHeaderTsx, /\/setup/);
  assert.match(appHeaderTsx, /\/reports/);
  assert.match(appHeaderTsx, /\/settings/);
  assert.match(appHeaderTsx, /\/api\/leads-logout/);

  for (const source of [
    leadsListTsx,
    setupPageTsx,
    settingsPageTsx,
    reportsPageTsx,
    leadConversationPageTsx,
    opsPageTsx,
    opsRunbookPageTsx,
    opsSetupRequestsPageTsx,
  ]) {
    assert.match(source, /AppHeader/);
  }

  assert.doesNotMatch(globalsCss, /\.mobile-owner-menu,\s*\.mobile-inbox-search\s*\{\s*display:\s*none/);
  assert.match(globalsCss, /\.mobile-owner-menu\s*\{[\s\S]{0,80}display:\s*block/);
  assert.match(globalsCss, /\.app-head__right\s*\{[\s\S]{0,180}flex-wrap:\s*nowrap/);
  assert.match(globalsCss, /\.app-head__right\s*\{[\s\S]{0,220}justify-content:\s*flex-end/);
  assert.match(globalsCss, /\.mobile-owner-menu\s*\{[\s\S]{0,100}flex:\s*0 0 auto/);
});

test("public homepage keeps an owner inbox path visible", () => {
  assert.match(homePageTsx, /<InboxLink className="btn btn-secondary btn-header home-header__inbox">/);
  assert.match(homePageTsx, /<InboxLink className="text-link">Open your inbox<\/InboxLink>/);
  assert.doesNotMatch(homePageTsx, /home-header__setup/);
  assert.match(homePageTsx, /Request setup/);
  assert.match(globalsCss, /\.home-view \.home-header__inbox/);
  assert.match(globalsCss, /\.leads-view \.app-head__right > \.btn/);
  assert.doesNotMatch(globalsCss, /\n\s*\.app-head__right > \.btn,\n\s*\.app-head__right > \.app-head__logout/);
});

test("Supabase Auth fails closed and refreshes sessions in middleware", () => {
  assert.match(envTs, /supabaseAnonKey: getRequiredEnv\("NEXT_PUBLIC_SUPABASE_ANON_KEY"\)/);
  assert.doesNotMatch(envTs, /missing-anon-key/);
  assert.match(middlewareTs, /createServerClient/);
  assert.match(middlewareTs, /supabase\.auth\.getUser\(\)/);
  assert.match(middlewareTs, /setAll\(cookiesToSet\)/);
  assert.match(middlewareTs, /"\/leads\/:path\*"/);
  assert.match(middlewareTs, /"\/setup\/:path\*"/);
  assert.match(middlewareTs, /"\/api\/leads\/:path\*"/);
  assert.match(middlewareTs, /"\/api\/sms-test\/:path\*"/);
  assert.doesNotMatch(middlewareTs, /\/api\/twilio/);
  assert.doesNotMatch(middlewareTs, /\/api\/intake/);
  assert.doesNotMatch(middlewareTs, /\/\(\(\?!_next\/static/);
});

test("login throttling avoids repeated magic-link lockouts and explains recovery", () => {
  assert.match(authLoginRouteTs, /LOGIN_LINK_COOLDOWN_SECONDS = 10 \* 60/);
  assert.match(authLoginRouteTs, /LOGIN_LINK_COOKIE = "relay_login_link_requested"/);
  assert.match(authLoginRouteTs, /requestedRecently\(cookieStore\.get\(LOGIN_LINK_COOKIE\)\?\.value, email, now\)/);
  assert.match(authLoginRouteTs, /redirect\(`\/login\?sent=recent/);
  assert.match(authLoginRouteTs, /error\.status === 429/);
  assert.match(authLoginRouteTs, /setLoginCooldownCookie\(cookieStore, email, now\)/);
  assert.match(authLoginRouteTs, /redirect\(`\/login\?error=rate_limited/);
  assert.match(authLoginRouteTs, /httpOnly:\s*true/);
  assert.match(authLoginRouteTs, /sameSite:\s*"lax"/);
  assert.match(loginPageTsx, /Too many sign-in link requests/);
  assert.match(loginPageTsx, /wait about 10 minutes/);
  assert.match(loginPageTsx, /disabled=\{shouldPauseRequests\}/);
});

test("email password is the primary owner sign-in path with magic link as fallback", () => {
  assert.match(loginPageTsx, /action="\/api\/auth\/password-login"/);
  assert.match(loginPageTsx, /autoComplete="current-password"/);
  assert.match(loginPageTsx, />\s*Sign in\s*</);
  // Recovery is one disclosed action; the magic link is tucked behind
  // "Other sign-in options" so the password form stays primary.
  assert.match(loginPageTsx, /action="\/api\/auth\/password-reset"/);
  assert.match(loginPageTsx, /Forgot or create password\?/);
  assert.match(loginPageTsx, /Email setup link/);
  assert.match(loginPageTsx, /action="\/api\/auth\/login"/);
  assert.match(loginPageTsx, /Other sign-in options/);
  assert.match(authPasswordLoginRouteTs, /signInWithPassword\(\{/);
  assert.match(authPasswordLoginRouteTs, /resolveAccountUserSessionForUser\(data\.user\)/);
  assert.match(authPasswordLoginRouteTs, /\/account\/select\?next=/);
  assert.match(authPasswordLoginRouteTs, /supabase\.auth\.signOut\(\)/);
  assert.match(authPasswordResetRouteTs, /resetPasswordForEmail\(email/);
  assert.match(authPasswordResetRouteTs, /\/account\/password/);
  assert.match(accountPasswordPageTsx, /requireAccountUser\(\)/);
  assert.match(authUpdatePasswordRouteTs, /resolveAccountUserSessionForUser\(userData\.user\)/);
  assert.match(authUpdatePasswordRouteTs, /updateUser\(\{ password \}\)/);
  assert.match(middlewareTs, /"\/account\/:path\*"/);
  assert.match(middlewareTs, /"\/api\/auth\/update-password"/);
});

test("magic-link callback resolves account from exchanged user, not same-request cookies", () => {
  assert.match(authTs, /resolveAccountUserSessionForUser/);
  assert.match(authCallbackRouteTs, /const \{ data, error \} = await supabase\.auth\.exchangeCodeForSession\(code\)/);
  assert.match(authCallbackRouteTs, /resolveAccountUserSessionForUser\(data\.user\)/);
  assert.match(authCallbackRouteTs, /\/account\/select\?next=/);
  assert.doesNotMatch(authCallbackRouteTs, /getAccountUserSession\(\)/);
});

test("multi-account users can choose an account through a server-owned selector", () => {
  assert.match(accountSelectPageTsx, /getAccountMembershipsForUser\(data\.user\)/);
  assert.match(accountSelectPageTsx, /action="\/api\/auth\/select-account"/);
  assert.match(accountSelectPageTsx, /Which inbox do you want to open\?/);
  assert.match(accountSelectPageTsx, /Current business/);
  assert.match(authSelectAccountRouteTs, /resolveAccountUserSessionForUser\(data\.user, accountId\)/);
  assert.match(authSelectAccountRouteTs, /setSelectedAccountCookie\(cookieStore, resolution\.session\.accountId\)/);
  assert.match(authSelectAccountRouteTs, /clearSelectedAccountCookie\(cookieStore\)/);
  assert.match(authSelectAccountRouteTs, /signOut\(\)/);
  assert.match(appHeaderTsx, /switchAccountHref/);
  assert.match(appHeaderTsx, /Switch business/);
});

test("authenticated setup page exposes onboarding checks without creating a new tenant path", () => {
  assert.match(setupPageTsx, /getForwardingHealthSummary\(accountId\)/);
  assert.match(setupPageTsx, /getA2pRegistrationStatus\(accountId\)/);
  // The forwarding + SMS checks are exposed through the unified Full-test panel.
  assert.match(setupPageTsx, /FullTestPanel/);
  assert.match(setupPageTsx, /Set up forwarding from your business number/);
  // Carrier-aware forwarding guidance; the codes live in lib/carriers (tested
  // in carriers.test.mjs) and render through the CarrierForwarding component.
  assert.match(setupPageTsx, /CarrierForwarding relayNumber=/);
  assert.doesNotMatch(setupPageTsx, /Guide the owner|The owner should|customer&apos;s carrier instructions/);
  assert.doesNotMatch(setupPageTsx, /provisionAccount|signUp|createUser|stripe/i);
});

test("README documents Supabase Auth instead of legacy leads password auth", () => {
  assert.match(readme, /Email\/password is the primary owner sign-in path/);
  assert.match(readme, /magic links remain a fallback/);
  assert.match(readme, /manually provisioned pilot accounts/);
  assert.match(readme, /npm run provision:account/);
  assert.match(readme, /\/ops\/setup-requests/);
  assert.match(readme, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(readme, /LEADS_PASSWORD/);
  assert.doesNotMatch(readme, /LEADS_COOKIE_SECRET/);
  assert.doesNotMatch(readme, /There is no auth system/);
  assert.doesNotMatch(readme, /password-protected|password gate|shared password/i);
  assert.doesNotMatch(readme, /intentionally single-business/);
});

test("setup SMS consent is optional", () => {
  assert.match(intakeFormTsx, /name="smsConsent"/);
  assert.doesNotMatch(intakeFormTsx, /name="smsConsent" required/);
});

test("setup request leads render as structured fields in the inbox", () => {
  assert.match(intakeRouteTs, /\.join\("\\n"\)/);
  assert.match(leadUtilsTs, /parseSetupRequestMessage/);
  assert.match(leadUtilsTs, /setupRequestSummary/);
  assert.match(leadUtilsTs, /Relay NW setup request/);
  assert.match(setupRequestDetailsTsx, /<dl className=/);
  assert.match(setupRequestDetailsTsx, /<dt>{field\.label}<\/dt>/);
  assert.match(setupRequestDetailsTsx, /<dd>{field\.value}<\/dd>/);
  assert.match(leadCardTsx, /setupRequestSummary\(setupRequestFields\)/);
  assert.doesNotMatch(leadCardTsx, /<SetupRequestDetails/);
  assert.match(leadDrawerTsx, /<SetupRequestDetails fields={setupRequestFields} \/>/);
  assert.match(globalsCss, /\.setup-request/);
});

test("voicemail greeting discloses recording", () => {
  assert.match(twimlTs, /recorded message/);
  assert.match(envExample, /recorded message/);
  assert.match(readme, /recorded message/);
});

test("STOP opt-outs notify the owner", () => {
  assert.match(emailTs, /export async function notifyOwnerOptOut/);
  assert.match(inboundSmsRouteTs, /notifyOwnerOptOut\(\{/);
  assert.match(inboundSmsRouteTs, /recordOptOut\(input\.from, account\.accountId\)/);
});

test("business-owned tables carry account_id", () => {
  for (const table of [
    "public.leads",
    "public.webhook_events",
    "public.opt_outs",
    "public.inbound_messages",
    "public.forwarding_health_checks",
  ]) {
    assert.match(sql, new RegExp(`alter table ${table.replace(".", "\\.")} add column if not exists account_id`));
  }
});

test("business-owned account_id columns are enforced after backfill", () => {
  for (const table of [
    "public.leads",
    "public.opt_outs",
    "public.inbound_messages",
    "public.forwarding_health_checks",
  ]) {
    assert.match(sql, new RegExp(`alter table ${table.replace(".", "\\.")} alter column account_id set not null`));
  }

  assert.doesNotMatch(sql, /alter table public\.webhook_events alter column account_id set not null/);
  assert.match(sql, /webhook_events\.account_id intentionally remains nullable/);
});

test("account_id backfill has dry-run apply script and runbook", () => {
  assert.match(packageJson, /"backfill:account-ids": "node scripts\/backfill-account-ids\.mjs"/);
  assert.match(backfillAccountIdsScript, /const BACKFILL_TABLES = \[/);
  assert.match(backfillAccountIdsScript, /"leads"/);
  assert.match(backfillAccountIdsScript, /"opt_outs"/);
  assert.match(backfillAccountIdsScript, /"inbound_messages"/);
  assert.match(backfillAccountIdsScript, /"forwarding_health_checks"/);
  assert.match(backfillAccountIdsScript, /--apply/);
  assert.match(backfillAccountIdsScript, /webhook_events/);
  assert.match(readme, /deploy the code that always writes `account_id`/);
  assert.match(readme, /npm run backfill:account-ids -- --slug=relay-nw --apply/);
  assert.match(readme, /webhook_events\.account_id` intentionally remains nullable/);
});

test("idempotency indexes are account scoped", () => {
  assert.match(sql, /unique \(account_id, call_sid\)/);
  assert.match(sql, /unique \(account_id, twilio_message_sid\)/);
  assert.match(sql, /opt_outs_account_phone_unique_idx/);
  assert.match(sql, /inbound_messages_account_message_sid_unique_idx/);
});

test("unsafe unsigned Twilio webhooks are blocked in production", () => {
  assert.match(envTs, /ALLOW_UNSIGNED_TWILIO_WEBHOOKS cannot be enabled in production/);
});

test("webhook sanitizer records metadata instead of raw SMS body", () => {
  assert.match(twilioTs, /rejectInvalidTwilioSignature/);
  assert.match(sql, /payload jsonb not null default '\{\}'::jsonb/);
  assert.doesNotMatch(sql, /raw_payload/);
});

test("RLS-enabled tables declare restrictive deny-all client policies", () => {
  const tables = Array.from(
    sql.matchAll(/alter table public\.([a-z_]+) enable row level security;/g),
    (match) => match[1],
  );

  assert.ok(tables.length > 0, "expected at least one RLS-enabled table");

  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(`drop policy if exists deny_client_access on public\\.${table};`),
      `${table} should drop/recreate the deny policy idempotently`,
    );
    assert.match(
      sql,
      new RegExp(
        `create policy deny_client_access on public\\.${table}\\s+as restrictive for all to anon, authenticated\\s+using \\(false\\) with check \\(false\\);`,
        "m",
      ),
      `${table} should deny anon/authenticated access with a restrictive policy`,
    );
  }
});
