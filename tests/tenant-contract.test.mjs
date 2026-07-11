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
const inboundSmsRouteTs = await readFile(new URL("../app/api/twilio/sms/route.ts", import.meta.url), "utf8");
const homePageTsx = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
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
  assert.match(sql, /account_users_user_id_unique_idx/);
  assert.match(sql, /account_users_email_idx/);
});

test("account verifier checks pilot provisioning prerequisites", () => {
  assert.match(packageJson, /"verify:account": "node scripts\/verify-account\.mjs"/);
  assert.match(verifyAccountScript, /account_settings/);
  assert.match(verifyAccountScript, /account_phone_numbers/);
  assert.match(verifyAccountScript, /account_users/);
  assert.match(verifyAccountScript, /owner_email is set/);
  assert.match(verifyAccountScript, /SMS is disabled unless A2P is ready/);
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
  assert.match(leadCardTsx, /booked \? "Mark as unbooked" : "Mark as booked"/);
  assert.match(leadCardTsx, /onBooked\(lead\.id, !booked\)/);
});

test("lead card actions keep workflow controls explicit and avoid duplicate details", () => {
  assert.match(leadCardTsx, /trigger=\{<>Status<\/>\}/);
  assert.match(leadCardTsx, /triggerAriaLabel="Change lead status"/);
  assert.doesNotMatch(leadCardTsx, />Details</);
});

test("mobile booked value control stays compact and polished", () => {
  assert.match(leadCardTsx, /<Icon name="star" size=\{13\} \/>/);
  assert.match(globalsCss, /@media \(max-width: 560px\)[\s\S]*\.lead-card__value\s*\{[\s\S]*display:\s*grid/);
  assert.match(globalsCss, /@media \(max-width: 560px\)[\s\S]*\.lead-card__value \.money-field--compact\s*\{[\s\S]*min-height:\s*46px/);
  assert.match(globalsCss, /@media \(max-width: 560px\)[\s\S]*\.lead-card__value \.money-field--compact input\s*\{[\s\S]*font-size:\s*20px/);
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

  for (const source of [leadsListTsx, setupPageTsx, settingsPageTsx, reportsPageTsx, leadConversationPageTsx]) {
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
  assert.match(homePageTsx, /Set up Relay NW/);
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

test("authenticated setup page exposes onboarding checks without creating a new tenant path", () => {
  assert.match(setupPageTsx, /getForwardingHealthSummary\(accountId\)/);
  assert.match(setupPageTsx, /getA2pRegistrationStatus\(accountId\)/);
  assert.match(setupPageTsx, /ForwardingHealthCard/);
  assert.match(setupPageTsx, /SmsHealthCard/);
  assert.match(setupPageTsx, /carrierCodeExample\("\*61\*", account\.twilioPhoneNumber\)/);
  assert.match(setupPageTsx, /carrierCodeExample\("\*67\*", account\.twilioPhoneNumber\)/);
  assert.match(setupPageTsx, /carrierCodeExample\("\*62\*", account\.twilioPhoneNumber\)/);
  assert.match(setupPageTsx, /Set up forwarding from your business number/);
  assert.match(setupPageTsx, /carrier apps, landlines, VoIP providers, and some regional carriers use different steps/);
  assert.match(setupPageTsx, /use your carrier&apos;s call-forwarding instructions/);
  assert.doesNotMatch(setupPageTsx, /Guide the owner|The owner should|customer&apos;s carrier instructions/);
  assert.match(setupPageTsx, /CopyButton/);
  assert.doesNotMatch(setupPageTsx, /provisionAccount|signUp|createUser|stripe/i);
});

test("README documents Supabase Auth instead of legacy leads password auth", () => {
  assert.match(readme, /Supabase Auth magic-link sign-in/);
  assert.match(readme, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(readme, /LEADS_PASSWORD/);
  assert.doesNotMatch(readme, /LEADS_COOKIE_SECRET/);
  assert.doesNotMatch(readme, /There is no auth system/);
  assert.doesNotMatch(readme, /password-protected|password gate|shared password/i);
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
