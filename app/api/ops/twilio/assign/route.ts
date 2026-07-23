import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { configureExistingRelayNumber, purchaseAndConfigureRelayNumber } from "@/lib/twilio";
import {
  assignPrimaryAccountPhoneNumber,
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

function go(slug: string, value: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?number=${value}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  if (operator.role === "support") redirect("/ops?error=forbidden");
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  const phoneNumber = String(form.get("phone_number") ?? "").trim();
  const action = String(form.get("action") ?? "attach_existing");
  if (!slug) redirect("/ops");
  if (!/^\+1\d{10}$/.test(phoneNumber)) go(slug, "invalid");
  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  try {
    const purchased = action === "purchase"
      ? await purchaseAndConfigureRelayNumber(phoneNumber)
      : await configureExistingRelayNumber(phoneNumber);
    const assignment = await assignPrimaryAccountPhoneNumber({
      accountId: account.accountId,
      phoneNumber: purchased.phoneNumber,
      twilioSid: purchased.sid,
    });
    const summary = assignment.numberChanged
      ? `Assigned Relay number ${purchased.phoneNumber}; call capture must be reconfirmed on the new routing configuration`
      : `Confirmed Relay number ${purchased.phoneNumber}`;
    await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: "provisioning.number_assigned", summary }] });
    await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "provisioning.number_assigned", summary });
    go(account.accountSlug, "assigned");
  } catch (error) {
    console.error("Relay number assignment failed", { accountId: account.accountId, error: error instanceof Error ? error.message : error });
    go(account.accountSlug, "failed");
  }
}
