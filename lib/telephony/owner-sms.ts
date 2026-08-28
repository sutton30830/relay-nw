import type { AccountRuntimeConfig } from "@/lib/supabase/accounts";
import { phoneLast4 } from "@/lib/phone";
import { getTelephonyProvider } from "@/lib/telephony/registry";

async function providerActionTools() {
  return import("@/lib/supabase/provider-actions");
}

// Texts the owner from the account's Relay number. Never throws: notification
// failures must not disturb the call or transcription pipeline that invoked it.
export async function sendOwnerSms(input: {
  account: Pick<AccountRuntimeConfig, "accountId" | "smsEnabled" | "ownerPhoneNumber" | "relayPhoneNumber" | "twilioPhoneNumber">;
  body: string;
  context: string;
  actionKey?: string;
}) {
  const { account } = input;
  const relayPhoneNumber = account.relayPhoneNumber || account.twilioPhoneNumber;
  const provider = getTelephonyProvider();
  const actionKey = input.actionKey ?? `owner_sms:${input.context}`;
  const tools = await providerActionTools().catch((error) => {
    console.error("Owner SMS recovery tools could not be loaded", {
      context: input.context,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  });
  const claimProviderActionRetry = tools?.claimProviderActionRetry;
  const recordProviderAction = tools?.recordProviderAction;

  if (!account.smsEnabled || !account.ownerPhoneNumber || !relayPhoneNumber) {
    if (account.accountId && typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: provider.identity.id,
          idempotencyKey: actionKey,
          internalStatus: "suppressed",
          providerStatus: "notification_not_configured",
          customerExplanation: "Relay could not send the owner text because texting setup is incomplete.",
          retryEligibility: "manual",
          recommendedNextAction: "Verify A2P approval and the owner mobile number, then run a notification test.",
          customerVisible: true,
          expectedSuppression: true,
        });
      } catch (recordError) {
        console.error("Could not record skipped owner SMS", {
          accountId: account.accountId,
          context: input.context,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
    return false;
  }

  try {
    if (
      account.accountId &&
      typeof recordProviderAction === "function" &&
      typeof claimProviderActionRetry === "function"
    ) {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: provider.identity.id,
          idempotencyKey: actionKey,
          internalStatus: "pending",
          providerStatus: "not_sent",
          customerExplanation: "Relay is preparing the owner text notification.",
          retryEligibility: "manual",
          recommendedNextAction: "Wait for provider acceptance before retrying.",
          customerVisible: false,
        });
        const claimed = await claimProviderActionRetry({
          accountId: account.accountId,
          idempotencyKey: actionKey,
          staleBefore: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        });
        if (!claimed) {
          console.info("Owner SMS duplicate suppressed by idempotency reservation", {
            accountId: account.accountId,
            context: input.context,
          });
          return true;
        }
      } catch (recordError) {
        console.error("Owner SMS action reservation failed; notification was not sent", {
          accountId: account.accountId,
          context: input.context,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
        return false;
      }
    }

    const message = await provider.sendSms({
      to: account.ownerPhoneNumber,
      from: relayPhoneNumber,
      body: input.body,
      idempotencyKey: actionKey,
      deliveryCallback: null,
    });
    const messageId = message.messageId.value;
    const initialStatus = message.status === "unknown" ? "accepted" : message.status;

    if (account.accountId && typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: provider.identity.id,
          idempotencyKey: actionKey,
          providerIdentifier: messageId,
          internalStatus: "accepted",
          providerStatus: initialStatus,
          customerExplanation: `${provider.identity.displayName} accepted the owner text notification.`,
          retryEligibility: "never",
          recommendedNextAction: "No retry is needed unless the owner reports non-delivery.",
          customerVisible: false,
        });
      } catch (recordError) {
        console.error("Provider accepted owner SMS, but Relay could not update action evidence", {
          accountId: account.accountId,
          context: input.context,
          provider: provider.identity.id,
          providerMessageId: messageId,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
    return true;
  } catch (error) {
    console.error("Owner SMS failed", {
      context: input.context,
      provider: provider.identity.id,
      ownerLast4: phoneLast4(account.ownerPhoneNumber),
      error: error instanceof Error ? error.message : error,
    });
    if (account.accountId && typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: provider.identity.id,
          idempotencyKey: actionKey,
          internalStatus: "failed",
          providerStatus: "send_failed",
          diagnosticDetail: error,
          customerVisible: true,
        });
      } catch (recordError) {
        console.error("Could not record owner SMS failure", {
          accountId: account.accountId,
          context: input.context,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
    return false;
  }
}
