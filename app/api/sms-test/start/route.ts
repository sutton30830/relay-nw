import { env } from "@/lib/env";
import { assertTenantAccount, createMessageIfNew } from "@/lib/supabase";
import { missedCallSmsBodyForAccount, phoneLast4, twilioClient } from "@/lib/twilio";
import { authorizeSmsTestRequest } from "../_auth";

export const dynamic = "force-dynamic";

function testSmsBody(account: Parameters<typeof missedCallSmsBodyForAccount>[0]) {
  return `[Relay NW test] ${missedCallSmsBodyForAccount(account)}`;
}

export async function POST() {
  const auth = await authorizeSmsTestRequest();
  if (auth.response) return auth.response;
  const account = assertTenantAccount(auth.session.account, "SMS test start");

  if (!account.smsEnabled) {
    return Response.json(
      { error: "SMS is disabled. Set SMS_ENABLED=true before sending test texts." },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const body = testSmsBody(account);
    const message = await twilioClient.messages.create({
      to: account.ownerPhoneNumber,
      from: account.twilioPhoneNumber,
      body,
      statusCallback: `${env.appBaseUrl}/api/twilio/sms-status`,
    });

    let trackingWarning: string | null = null;
    try {
      await createMessageIfNew({
        accountId: account.accountId,
        twilioMessageSid: message.sid,
        direction: "outbound",
        fromPhone: account.twilioPhoneNumber,
        toPhone: account.ownerPhoneNumber,
        body,
        status: message.status,
      });
    } catch (trackingError) {
      trackingWarning = "SMS test was accepted by Twilio, but Relay could not register the MessageSid for status callbacks.";
      console.warn("SMS test MessageSid registration failed", {
        messageSid: message.sid,
        accountId: account.accountId,
        error: trackingError instanceof Error ? trackingError.message : trackingError,
      });
    }

    console.info("sms_test_started", {
      messageSid: message.sid,
      ownerLast4: phoneLast4(account.ownerPhoneNumber),
      status: message.status,
    });

    return Response.json(
      {
        messageSid: message.sid,
        status: message.status,
        toLast4: phoneLast4(account.ownerPhoneNumber),
        trackingWarning,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMS test error";

    console.error("Failed to send SMS test", {
      ownerLast4: phoneLast4(account.ownerPhoneNumber),
      error: message,
    });

    return Response.json(
      { error: "Twilio could not send the SMS test.", detail: message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
