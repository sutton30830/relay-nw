import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  createMessageIfNew,
  createMissedCallLeadIfNew,
  hasRecentMissedCallSms,
  getKnownContactByPhone,
  recordAutomaticSmsAttempt,
  type KnownContact,
  isOptedOut,
  recordProviderAction,
  assertTenantAccount,
  type AccountRuntimeConfig,
  updateCallForMissedLead,
  updateLeadSmsStatus,
} from "@/lib/supabase";
import { envAccountConfig } from "@/lib/supabase/accounts";
import { missedCallSmsBodyForAccount, phoneLast4, sendOwnerSms } from "@/lib/twilio";
import { getTelephonyProvider } from "@/lib/telephony/registry";
import { notifyAdminOperationalIssue, notifyOwnerNewMissedCallLead } from "@/lib/email";

type OwnerSmsStatus = "sent" | "failed" | "skipped_opt_out" | "skipped_recent" | "skipped_disabled" | "skipped_known_contact" | "blocked_pre_send";

async function notifyOwnerNewLeadByPush(input: {
  account: Pick<AccountRuntimeConfig, "accountId" | "businessName">;
  leadId: string;
  callerPhone: string;
}) {
  try {
    const { notifyOwnerByWebPush } = await import("@/lib/web-push");
    return await notifyOwnerByWebPush({
      account: input.account,
      event: "missed_call",
      leadId: input.leadId,
      callerPhone: input.callerPhone,
    });
  } catch (error) {
    console.error("Owner Web Push notification could not start", {
      accountId: input.account.accountId,
      leadId: input.leadId,
      error: error instanceof Error ? error.message : error,
    });
    return { attempted: 0, delivered: 0, disabled: 0 };
  }
}

function ownerSmsBody(input: {
  businessName: string;
  callerPhone: string;
  smsStatus: OwnerSmsStatus;
  leadId: string;
  callerName?: string | null;
}) {
  const inboxUrl = `${env.appBaseUrl}/leads/${encodeURIComponent(input.leadId)}`;
  const caller = input.callerName ? `${input.callerName.slice(0, 120)} (${input.callerPhone})` : input.callerPhone;

  if (input.smsStatus === "sent") {
    return `Relay NW: missed call for ${input.businessName} from ${caller}. We texted them back. Reply from your inbox: ${inboxUrl}`;
  }

  if (input.smsStatus === "skipped_opt_out") {
    return `Relay NW: missed call for ${input.businessName} from ${caller}. They opted out of texting, so call them back. Inbox: ${inboxUrl}`;
  }

  if (input.smsStatus === "skipped_recent") {
    return `Relay NW: ${caller} called ${input.businessName} again and was missed. They were already texted, so no new auto-text went out. Consider calling back. Inbox: ${inboxUrl}`;
  }

  if (input.smsStatus === "skipped_known_contact") {
    return `Relay NW: missed call for ${input.businessName} from ${caller}. Not auto-texted: known contact. Reply or call from your inbox: ${inboxUrl}`;
  }
  if (input.smsStatus === "blocked_pre_send") {
    return `Relay NW: missed call for ${input.businessName} from ${caller}. Not texted: texting checks unavailable. Call them or review before replying: ${inboxUrl}`;
  }
  if (input.smsStatus === "skipped_disabled") {
    return `Relay NW: missed call for ${input.businessName} from ${caller}. Automatic texting is disabled. Inbox: ${inboxUrl}`;
  }
  return `Relay NW: missed call for ${input.businessName} from ${caller}. The auto-text FAILED. Call them back now. Inbox: ${inboxUrl}`;
}

// Texts the owner about a new missed-call lead. Email can sit unread for hours; owners
// live in their messages app. Never throws: a notification failure must not disturb the
// customer-facing flow, and the owner still gets the email fallback.
async function notifyOwnerNewLeadBySms(input: {
  account: Pick<
    AccountRuntimeConfig,
    "accountId" | "smsEnabled" | "ownerPhoneNumber" | "relayPhoneNumber" | "twilioPhoneNumber" | "businessName" | "notificationPreferences"
  >;
  callerPhone: string;
  smsStatus: OwnerSmsStatus;
  correlationId: string;
  leadId: string;
  callerName?: string | null;
}) {
  const { account } = input;
  const relayPhoneNumber = account.relayPhoneNumber || account.twilioPhoneNumber;

  if (account.notificationPreferences?.missedCall.sms === false) {
    console.info("Owner missed-call SMS suppressed by account preference", {
      accountId: account.accountId,
      correlationId: input.correlationId,
    });
    return;
  }

  // Owner SMS rides the same A2P-gated number as customer texting. If customer texting
  // is disabled (campaign not approved yet), do not send owner texts from it either.
  if (!account.smsEnabled || !account.ownerPhoneNumber || !relayPhoneNumber) {
    return;
  }

  // Don't text the owner about their own call (e.g. the owner testing their line).
  if (normalizePhoneNumber(input.callerPhone) === account.ownerPhoneNumber) {
    return;
  }

  try {
    const body = ownerSmsBody({
      businessName: account.businessName,
      callerPhone: input.callerPhone,
      smsStatus: input.smsStatus,
      leadId: input.leadId,
      callerName: input.callerName,
    });
    const actionKey = `owner_sms:missed_call:${input.correlationId}`;
    if (typeof sendOwnerSms === "function") {
      await sendOwnerSms({
        account,
        context: "missed-call owner notification",
        actionKey,
        body,
      });
    } else {
      const provider = getTelephonyProvider();
      await provider.sendSms({
        to: account.ownerPhoneNumber,
        from: relayPhoneNumber,
        body,
        idempotencyKey: actionKey,
        deliveryCallback: null,
      });
    }
  } catch (error) {
    console.error("Owner SMS notification failed (email fallback still sent)", {
      correlationId: input.correlationId,
      ownerLast4: phoneLast4(account.ownerPhoneNumber),
      smsStatus: input.smsStatus,
      error: error instanceof Error ? error.message : error,
    });
  }
}

export async function handleMissedCall(input: {
  account?: AccountRuntimeConfig;
  callerPhone: string;
  providerCallId?: string;
  /** @deprecated Compatibility alias for legacy webhook callers. */
  callSid?: string;
  message: string | null;
  correlationId?: string | null;
  providerSignatureValid?: boolean;
  /** @deprecated Compatibility alias for legacy webhook callers. */
  twilioSignatureValid?: boolean;
}) {
  const callerPhone = normalizePhoneNumber(input.callerPhone);
  const providerCallId = (input.providerCallId ?? input.callSid)?.trim() ?? "";
  const correlationId = input.correlationId ?? providerCallId;
  const account = assertTenantAccount(input.account ?? envAccountConfig(), "handleMissedCall");
  const relayPhoneNumber = account.relayPhoneNumber || account.twilioPhoneNumber;
  const provider = getTelephonyProvider();
  if (!callerPhone || !providerCallId) throw new Error("Missing caller phone or provider call identifier on missed call webhook.");

  // Durable capture and duplicate handling precede every preference lookup.
  const leadResult = await createMissedCallLeadIfNew({
    accountId: account.accountId, providerCallId, phone: callerPhone, message: input.message,
    providerSignatureValid: (input.providerSignatureValid ?? input.twilioSignatureValid) === true,
  });
  if (!leadResult.inserted || !leadResult.leadId) {
    return { inserted: false, becameLive: false, smsStatus: "duplicate" as const };
  }
  const leadId = leadResult.leadId;
  const providerActionKey = `automatic_missed_call_sms:${leadId}`;
  const action = {
    accountId: account.accountId, action: "automatic_missed_call_sms", idempotencyKey: providerActionKey,
    resourceType: "lead", resourceId: leadId,
  };
  const ownerPushPromise = notifyOwnerNewLeadByPush({ account, leadId, callerPhone });
  let contact: KnownContact | null = null;
  let contactUnavailable = false;
  const suppresses = (value: KnownContact | null) => value !== null &&
    (value.classification !== "customer" || value.auto_sms_policy !== "standard");

  async function safely(label: string, operation: () => Promise<unknown>) {
    try { await operation(); }
    catch { console.error(label, { accountId: account.accountId, leadId, correlationId }); }
  }
  async function adminIssue(issue: string, detail: string) {
    await safely("Could not notify Operations", () => notifyAdminOperationalIssue({ account, issue, detail, correlationId }));
  }
  async function finish<T extends { smsStatus: string }>(result: T) {
    const smsStatus: OwnerSmsStatus = result.smsStatus === "sent_update_failed" ? "sent" : result.smsStatus as OwnerSmsStatus;
    // Keep channels independent, including when persistence or a notification fails.
    await Promise.all([
      safely("Owner missed-call email failed", () => notifyOwnerNewMissedCallLead({
        account, leadId, callerPhone, callerName: contact?.display_name, smsStatus,
      })),
      safely("Owner missed-call SMS failed", () => notifyOwnerNewLeadBySms({
        account, leadId, callerPhone, callerName: contact?.display_name, smsStatus, correlationId,
      })),
      ownerPushPromise,
    ]);
    return { inserted: true, becameLive: leadResult.becameLive, ...result };
  }
  async function metadataIssue() {
    await safely("Could not record contact lookup issue", () => recordProviderAction({
      accountId: account.accountId, action: "known_contact_lookup", provider: "supabase",
      idempotencyKey: `known_contact_lookup:${leadId}`, resourceType: "lead", resourceId: leadId,
      internalStatus: "failed", providerStatus: "contact_lookup_failed", countAttempt: false,
      diagnosticDetail: "Contact metadata was unavailable; established SMS suppression remains in effect.",
      customerExplanation: "Contact details could not be loaded.", customerVisible: false,
      retryEligibility: "never", recommendedNextAction: "Check contact storage in Operations. No automatic resend is scheduled.",
    }));
    await adminIssue("Missed-call contact lookup failed", "Contact metadata was unavailable. Existing account or recipient suppression was preserved.");
  }
  async function skip(smsStatus: "skipped_disabled" | "skipped_opt_out" | "skipped_known_contact" | "skipped_recent") {
    const reasons = {
      skipped_disabled: ["sms_disabled", "Automatic texting is not enabled for this account."],
      skipped_opt_out: ["opted_out", "The caller opted out of texting, so Relay did not send a message."],
      skipped_known_contact: ["known_contact", "Not auto-texted: known contact."],
      skipped_recent: ["cooldown", "Relay did not send a duplicate automatic text during the cooldown window."],
    } as const;
    await safely("Could not record skipped SMS status", () => updateLeadSmsStatus({ accountId: account.accountId, id: leadId, smsStatus }));
    await safely("Could not record SMS suppression", () => recordProviderAction({
      ...action, provider: "relay", internalStatus: "suppressed", providerStatus: reasons[smsStatus][0],
      customerExplanation: reasons[smsStatus][1], retryEligibility: "never",
      recommendedNextAction: "Review the missed call and follow up manually if appropriate.",
      customerVisible: false, expectedSuppression: true, countAttempt: false,
    }));
    if (contactUnavailable) await metadataIssue();
    return finish({ smsStatus });
  }
  async function blocked(check: string) {
    const detail = `Could not verify SMS account/opt-out/contact/cooldown checks. SMS not sent. Unavailable check: ${check}.`;
    await safely("Could not record blocked pre-send status", () => updateLeadSmsStatus({
      accountId: account.accountId, id: leadId, smsStatus: "blocked_pre_send", smsError: detail,
    }));
    await safely("Could not record pre-send check failure", () => recordProviderAction({
      ...action, provider: "supabase", internalStatus: "failed", providerStatus: "pre_send_check_failed",
      diagnosticDetail: detail, customerExplanation: "Not texted: texting checks unavailable.",
      retryEligibility: "never", recommendedNextAction: "Check Operations, then call or explicitly reply from the inbox. Do not replay this automatic text.",
      customerVisible: true, expectedSuppression: false, countAttempt: false,
    }));
    await adminIssue("Missed-call SMS pre-send checks failed (SMS not sent)", detail);
    return finish({ smsStatus: "blocked_pre_send" as const, smsError: detail });
  }

  await safely("Could not link call row to missed-call lead", () => updateCallForMissedLead({
    accountId: account.accountId, providerCallId, leadId, status: "missed",
  }));
  // Resolve metadata even when caller texting is disabled. Never treat a failed
  // lookup as evidence that a number is unknown.
  try { contact = await getKnownContactByPhone(account.accountId, callerPhone); }
  catch { contactUnavailable = true; }
  if (!account.smsEnabled) return skip("skipped_disabled");

  let recentlyTexted: boolean;
  let smsRequest: Parameters<typeof provider.sendSms>[0];
  let check = "recipient opt-out";
  try {
    if (await isOptedOut(callerPhone, account.accountId)) return skip("skipped_opt_out");
    if (contactUnavailable) return blocked("known-contact lookup");
    if (suppresses(contact)) return skip("skipped_known_contact");
    check = "cooldown";
    recentlyTexted = await hasRecentMissedCallSms(
      callerPhone, new Date(Date.now() - account.missedCallSmsCooldownHours * 60 * 60 * 1000),
      account.accountId, leadId, leadResult.createdAt ?? null,
    );
    if (recentlyTexted) return skip("skipped_recent");
    check = "message preparation";
    smsRequest = {
      to: callerPhone, from: relayPhoneNumber, body: missedCallSmsBodyForAccount(account),
      idempotencyKey: providerActionKey,
      deliveryCallback: {
        url: new URL("/api/twilio/sms-status", env.appBaseUrl).toString(),
        metadata: { messageType: "auto_text", accountId: account.accountId, leadId, actionKey: providerActionKey },
      },
    };
    check = "provider action reservation";
    await recordProviderAction({
      ...action, provider: provider.identity.id, internalStatus: "processing", providerStatus: "checking_eligibility",
      customerExplanation: "Relay is checking whether this automatic text can be sent.",
      retryEligibility: "never", recommendedNextAction: "Wait for eligibility checks. Do not resend automatically.",
      customerVisible: false, countAttempt: false,
    });
    // Final, uncached decision boundary. Build/reserve everything before these
    // reads; no notification or bookkeeping await may follow the contact read
    // before initiating the provider request. Later edits cannot recall a send.
    check = "final recipient opt-out";
    if (await isOptedOut(callerPhone, account.accountId)) return skip("skipped_opt_out");
    check = "final known-contact lookup";
    contact = await getKnownContactByPhone(account.accountId, callerPhone);
    if (suppresses(contact)) return skip("skipped_known_contact");
  } catch { return blocked(check); }

  let message: Awaited<ReturnType<typeof provider.sendSms>>;
  try {
    message = await provider.sendSms(smsRequest);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown SMS send error";
    await safely("Could not record automatic SMS provider failure", () => recordProviderAction({
      ...action, provider: provider.identity.id, internalStatus: "failed", providerStatus: "send_failed",
      diagnosticDetail: detail, customerVisible: true, retryEligibility: "never",
      recommendedNextAction: "Check provider evidence before explicitly replying or calling. Do not automatically resend.",
    }));
    await safely("Could not record automatic SMS attempt", () => recordAutomaticSmsAttempt(account.accountId, providerActionKey));
    await safely("Could not record SMS failure", () => updateLeadSmsStatus({ accountId: account.accountId, id: leadId, smsStatus: "failed", smsError: detail }));
    await adminIssue("Missed-call SMS send failed", detail);
    return finish({ smsStatus: "failed" as const, smsError: detail });
  }

  // Provider acceptance is irreversible. No persistence/notification failure
  // below can enter the provider-send catch or turn acceptance into a failure.
  const providerMessageId = message.messageId.value;
  await safely("Provider accepted SMS, but action evidence could not be recorded", () => recordProviderAction({
    ...action, provider: provider.identity.id, providerIdentifier: providerMessageId,
    internalStatus: "accepted", providerStatus: message.status === "unknown" ? "accepted" : message.status,
    customerExplanation: `${provider.identity.displayName} accepted the automatic text. Delivery confirmation is pending.`,
    retryEligibility: "never", recommendedNextAction: "Wait for the signed delivery callback; do not resend automatically.",
    customerVisible: false, countAttempt: false,
  }));
  await safely("Could not record automatic SMS attempt", () => recordAutomaticSmsAttempt(account.accountId, providerActionKey));
  let messageRowRecorded = true;
  try {
    await createMessageIfNew({
      accountId: account.accountId, leadId, providerMessageId, direction: "outbound",
      fromPhone: relayPhoneNumber, toPhone: callerPhone, body: smsRequest.body, status: "sent",
    });
  } catch (error) {
    messageRowRecorded = false;
    await adminIssue("Provider accepted SMS but message row insert failed", `${error instanceof Error ? error.message : "Message insert failed"} (provider message ID ${providerMessageId})`);
  }
  try {
    await updateLeadSmsStatus({ accountId: account.accountId, id: leadId, smsStatus: "sent", providerMessageId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Lead update failed";
    await adminIssue("Provider accepted SMS but lead update failed", messageRowRecorded
      ? `${detail} — the signed status callback can reconcile the lead via the messages table.`
      : `${detail} — the message row also failed; check provider message ID ${providerMessageId} in ${provider.identity.displayName}.`);
    return finish({ smsStatus: "sent_update_failed" as const, providerMessageId, twilioMessageSid: providerMessageId });
  }
  return finish({ smsStatus: "sent" as const, providerMessageId, twilioMessageSid: providerMessageId });
}
