import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

function parseDotenvLine(line) {
  const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

async function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    const contents = await readFile(file, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const parsed = parseDotenvLine(line);
      if (parsed) process.env[parsed[0]] ??= parsed[1];
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function roundSeconds(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

async function main() {
  await loadLocalEnv();
  const slug = process.argv[2]?.trim();
  if (!slug) throw new Error("Usage: npm run baseline:pilot -- <account-slug>");

  const supabase = createClient(
    process.env.SUPABASE_URL || requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id, slug, name, status, onboarding_status, billing_status, billing_policy, commercial_offer, setup_fee_status, free_access_review_at")
    .eq("slug", slug)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account) throw new Error(`Account not found: ${slug}`);

  let [settingsResult, leadsResult, messagesResult, repliesResult, carrierResult, evidenceResult] = await Promise.all([
    supabase
      .from("account_settings")
      .select("a2p_registration_status, sms_enabled, voicemail_transcription_enabled, typical_job_value_cents")
      .eq("account_id", account.id)
      .maybeSingle(),
    supabase
      .from("leads")
      .select("id, source, status, created_at, booked_at, job_value_cents, recording_sid, voicemail_transcript, voicemail_summary, voicemail_transcription_status, deleted_at")
      .eq("account_id", account.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(5000),
    supabase
      .from("messages")
      .select("lead_id, direction, status, created_at")
      .eq("account_id", account.id)
      .order("created_at", { ascending: true })
      .limit(5000),
    supabase
      .from("inbound_messages")
      .select("id, lead_id")
      .eq("account_id", account.id)
      .limit(5000),
    supabase
      .from("account_carrier_profiles")
      .select("status, status_detail, updated_at")
      .eq("account_id", account.id)
      .maybeSingle(),
    supabase
      .from("account_onboarding_evidence")
      .select("owner_notification_sent_at, owner_notification_confirmed_at, customer_go_live_approved_at")
      .eq("account_id", account.id)
      .maybeSingle(),
  ]);

  const repliesHaveLeadIds = !repliesResult.error;
  if (repliesResult.error?.message.toLowerCase().includes("lead_id")) {
    repliesResult = await supabase
      .from("inbound_messages")
      .select("id")
      .eq("account_id", account.id)
      .limit(5000);
  }

  for (const result of [settingsResult, leadsResult, messagesResult, repliesResult]) {
    if (result.error) throw result.error;
  }
  // Carrier/evidence tables were introduced after the first pilot schema. A
  // missing optional row is meaningful; a missing legacy table should not make
  // the core activity baseline unusable.
  if (carrierResult.error && !carrierResult.error.message.includes("account_carrier_profiles")) {
    throw carrierResult.error;
  }
  if (evidenceResult.error && !evidenceResult.error.message.includes("account_onboarding_evidence")) {
    throw evidenceResult.error;
  }

  const leads = leadsResult.data ?? [];
  const missedCalls = leads.filter((lead) => lead.source === "missed_call");
  const messages = messagesResult.data ?? [];
  const firstOutboundByLead = new Map();
  for (const message of messages) {
    if (message.direction !== "outbound" || !message.lead_id || firstOutboundByLead.has(message.lead_id)) continue;
    firstOutboundByLead.set(message.lead_id, message.created_at);
  }

  const responseSeconds = missedCalls.flatMap((lead) => {
    const sentAt = firstOutboundByLead.get(lead.id);
    if (!sentAt) return [];
    const seconds = (new Date(sentAt).getTime() - new Date(lead.created_at).getTime()) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 ? [seconds] : [];
  });
  const booked = leads.filter((lead) => Boolean(lead.booked_at) || lead.status === "booked");
  const recordings = missedCalls.filter((lead) => Boolean(lead.recording_sid));
  const transcripts = recordings.filter((lead) => Boolean(lead.voicemail_transcript));
  const summaries = recordings.filter((lead) => Boolean(lead.voicemail_summary));
  const transcriptOnly = recordings.filter(
    (lead) => Boolean(lead.voicemail_transcript) && !lead.voicemail_summary,
  );
  const knownBookedValueCents = booked.reduce(
    (total, lead) => total + Math.max(0, Number(lead.job_value_cents) || 0),
    0,
  );
  const replyLeadIds = new Set(
    (repliesResult.data ?? []).map((reply) => reply.lead_id).filter(Boolean),
  );
  const settings = settingsResult.data;
  const carrier = carrierResult.data ?? null;
  const evidence = evidenceResult.data ?? null;

  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    account: {
      slug: account.slug,
      name: account.name,
      status: account.status,
      technicalSetupStatus: account.onboarding_status,
      billingStatus: account.billing_status,
      billingPolicy: account.billing_policy,
      commercialOffer: account.commercial_offer,
      setupFeeStatus: account.setup_fee_status,
      freeAccessReviewAt: account.free_access_review_at,
    },
    readiness: {
      relayA2pStatus: settings?.a2p_registration_status ?? "not_started",
      twilioProfileStatus: carrier?.status ?? null,
      lastTwilioSyncAt: carrier?.updated_at ?? null,
      smsEnabled: Boolean(settings?.sms_enabled),
      voicemailTranscriptionEnabled: Boolean(settings?.voicemail_transcription_enabled),
      ownerNotificationSentAt: evidence?.owner_notification_sent_at ?? null,
      ownerNotificationConfirmedAt: evidence?.owner_notification_confirmed_at ?? null,
      customerGoLiveApprovedAt: evidence?.customer_go_live_approved_at ?? null,
    },
    activity: {
      missedCalls: missedCalls.length,
      recordings: recordings.length,
      transcripts: transcripts.length,
      summaries: summaries.length,
      transcriptOnlyRecoverable: transcriptOnly.length,
      outboundMessages: messages.filter((message) => message.direction === "outbound").length,
      deliveredOutboundMessages: messages.filter(
        (message) => message.direction === "outbound" && message.status === "delivered",
      ).length,
      inboundReplies: repliesResult.data?.length ?? 0,
      uniqueReplyLeads: repliesHaveLeadIds ? replyLeadIds.size : repliesResult.data?.length ?? 0,
      uniqueReplyLeadsIsFallback: !repliesHaveLeadIds,
      responseTime: {
        medianSeconds: roundSeconds(median(responseSeconds)),
        sampleSize: responseSeconds.length,
      },
      bookings: booked.length,
      bookingsWithValue: booked.filter((lead) => (Number(lead.job_value_cents) || 0) > 0).length,
      knownRecoveredValueCents: knownBookedValueCents,
      estimatedMissingBookedValueCents: booked.filter((lead) => !lead.job_value_cents).length *
        Math.max(0, Number(settings?.typical_job_value_cents) || 0),
      lastMissedCallAt: missedCalls.at(-1)?.created_at ?? null,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
