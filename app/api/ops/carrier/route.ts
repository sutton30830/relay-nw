import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import {
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountSettings,
  upsertCarrierProfile,
} from "@/lib/supabase";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?carrier=${result}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  if (operator.role === "support") redirect("/ops?error=forbidden");
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  const action = String(form.get("action") ?? "").trim();
  if (!slug) redirect("/ops");
  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  const mapping = {
    submitted: { profile: "submitted", a2p: "in_progress" },
    in_progress: { profile: "in_progress", a2p: "in_progress" },
    approved: { profile: "approved", a2p: "approved" },
    needs_changes: { profile: "needs_changes", a2p: "needs_attention" },
    rejected: { profile: "rejected", a2p: "rejected" },
  } as const;
  const next = mapping[action as keyof typeof mapping];
  if (!next) go(account.accountSlug, "invalid_action");
  const detail = String(form.get("status_detail") ?? "").trim().slice(0, 500) || null;
  await upsertCarrierProfile(account.accountId, {
    status: next.profile,
    status_detail: detail,
    twilio_brand_sid: String(form.get("twilio_brand_sid") ?? "").trim() || null,
    twilio_campaign_sid: String(form.get("twilio_campaign_sid") ?? "").trim() || null,
    messaging_service_sid: String(form.get("messaging_service_sid") ?? "").trim() || null,
  });
  await updateAccountSettings(account.accountId, { a2p_registration_status: next.a2p });
  const summary = `Carrier registration marked ${action.replaceAll("_", " ")}${detail ? ` — ${detail}` : ""}`;
  await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: `carrier.${action}`, summary }] });
  await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: `carrier.${action}`, summary });
  go(account.accountSlug, action);
}
