import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { sealProfileValue } from "@/lib/secure-field";
import {
  getCarrierProfile,
  recordAccountAuditEvents,
  upsertCarrierProfile,
} from "@/lib/supabase";

function value(form: FormData, key: string, max = 1000) {
  return String(form.get(key) ?? "").trim().slice(0, max);
}

export async function POST(request: Request) {
  const session = await requireAccountUser();
  if (session.role === "viewer") redirect("/setup?carrier=forbidden");
  const form = await request.formData();
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
  const samples = value(form, "sample_messages", 3000).split("\n").map((item) => item.trim()).filter(Boolean).slice(0, 5);
  if (!firstName || !lastName || !mobile || !email || !useCase || !optInFlow || samples.length < 2) {
    redirect("/setup?carrier=incomplete#carrier-registration");
  }
  if (hasEin && !registrationId) redirect("/setup?carrier=registration_id_required#carrier-registration");
  if ((privacyPolicyUrl && !/^https:\/\//.test(privacyPolicyUrl)) || (termsUrl && !/^https:\/\//.test(termsUrl))) {
    redirect("/setup?carrier=invalid_url#carrier-registration");
  }
  const existing = await getCarrierProfile(session.accountId);
  const encrypted = registrationId ? sealProfileValue(registrationId) : existing?.registrationIdEncrypted ?? null;
  await upsertCarrierProfile(session.accountId, {
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
  await recordAccountAuditEvents({
    accountId: session.accountId,
    actorUserId: session.userId,
    actorEmail: session.email,
    events: [{ action: "onboarding.carrier_profile_ready", summary: "Completed the carrier registration information" }],
  });
  redirect("/setup?carrier=saved#carrier-registration");
}
