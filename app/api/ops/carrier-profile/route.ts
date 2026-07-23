import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { sealProfileValue } from "@/lib/secure-field";
import {
  getCarrierProfile,
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  upsertCarrierProfile,
} from "@/lib/supabase";

// Concierge carrier registration: Relay fills in the A2P questionnaire on the
// customer's behalf (from the setup call) instead of assigning the most
// jargon-heavy form in the product to a plumber. Mirrors the owner-side route,
// keyed by explicit account slug and audited as entered by Relay.

function value(form: FormData, key: string, max = 1000) {
  return String(form.get(key) ?? "").trim().slice(0, max);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const form = await request.formData();
  const slug = value(form, "account_slug", 80);
  if (!slug) redirect("/ops");

  const account = await getOpsAccountBySlug(slug);
  if (!account) redirect("/ops");
  const back = (status: string) =>
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?carrier_profile=${status}`);

  const hasEin = value(form, "has_ein") === "yes";
  const registrationId = value(form, "registration_id", 40).replace(/[^A-Za-z0-9-]/g, "");
  const firstName = value(form, "representative_first_name", 80);
  const lastName = value(form, "representative_last_name", 80);
  const title = value(form, "representative_title", 100);
  const mobile = value(form, "representative_mobile", 30);
  const email = value(form, "representative_email", 200).toLowerCase();
  const useCase = value(form, "messaging_use_case", 500);
  const optInFlow = value(form, "opt_in_flow", 2000);
  const privacyPolicyUrl = value(form, "privacy_policy_url", 500);
  const termsUrl = value(form, "terms_url", 500);
  const samples = value(form, "sample_messages", 3000)
    .split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 5);

  if (!firstName || !lastName || !mobile || !email || !useCase || !optInFlow || samples.length < 2) {
    back("incomplete");
  }
  if (hasEin && !registrationId) back("registration_id_required");
  if ((privacyPolicyUrl && !/^https:\/\//.test(privacyPolicyUrl)) || (termsUrl && !/^https:\/\//.test(termsUrl))) {
    back("invalid_url");
  }

  const existing = await getCarrierProfile(account.accountId);
  const encrypted = registrationId ? sealProfileValue(registrationId) : existing?.registrationIdEncrypted ?? null;
  await upsertCarrierProfile(account.accountId, {
    status: "ready",
    has_ein: hasEin,
    registration_type: hasEin ? "EIN" : "SOLE_PROPRIETOR",
    registration_id_encrypted: encrypted,
    registration_id_last4: registrationId ? registrationId.slice(-4) : existing?.registrationIdLast4 ?? null,
    representative_first_name: firstName,
    representative_last_name: lastName,
    representative_title: title || null,
    representative_mobile: mobile,
    representative_email: email,
    messaging_use_case: useCase,
    opt_in_flow: optInFlow,
    sample_messages: samples,
    privacy_policy_url: privacyPolicyUrl || null,
    terms_url: termsUrl || null,
    status_detail: null,
  });
  const summary = "Relay entered the carrier registration information with the customer";
  await recordAccountAuditEvents({
    accountId: account.accountId,
    actorUserId: operator.userId,
    actorEmail: operator.email,
    events: [{ action: "ops.carrier_profile_entered", summary }],
  });
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: account.accountId,
    action: "ops.carrier_profile_entered",
    summary,
  });

  back("saved");
}
